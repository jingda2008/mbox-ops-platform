import {appendAuditEvent,appendOutboxMessage,type AuditActor,type JsonObject} from './command-executor.js'
import {CustomerExperienceRequestError} from './customer-experience-repository.js'
import type {ServiceTask} from './service-task-repository.js'
import type {ScopedTransaction} from './transaction-runner.js'

interface Plan extends Record<string,unknown>{id:string;table_session_id:string;plan_state:string;business_date:string;session_status:string}
export interface LockedExperienceCue extends Plan {cue_id:string;status:string;service_task_id:string|null}
export class ExperiencePlanLifecycleConflict extends CustomerExperienceRequestError {
  constructor(){super('体验节点尚未可执行、已取消或与原服务任务不一致，请刷新核对','EXPERIENCE_CUE_NOT_ACTIONABLE',409)}
}

/** Parents always precede cue/task locks, including terminal-fact recovery. */
export class ExperiencePlanLifecycleRepository {
  constructor(private readonly tx:ScopedTransaction){}
  async lockByCue(cueId:string):Promise<LockedExperienceCue>{
    const location=await this.tx.query<{id:string;table_session_id:string}>(`SELECT plan.id,plan.table_session_id
      FROM mbox.experience_plan_cues cue JOIN mbox.customer_experience_plans plan
        ON (plan.tenant_id,plan.store_id,plan.id)=(cue.tenant_id,cue.store_id,cue.experience_plan_id)
      WHERE cue.tenant_id=$1 AND cue.store_id=$2 AND cue.id=$3`,[...this.scope(),cueId])
    const row=location.rows[0];if(!row)throw new ExperiencePlanLifecycleConflict()
    const plan=await this.lockPlan(row.id,row.table_session_id)
    const cues=await this.lockCues(plan.id),cue=cues.find(c=>c.cue_id===cueId)
    if(!cue)throw new ExperiencePlanLifecycleConflict()
    return {...plan,...cue}
  }
  async lockByTask(task:ServiceTask):Promise<LockedExperienceCue|null>{
    // The snapshot is user-writable descriptive data. Only the database FK and
    // original plan/session relationship establish an experience linkage.
    const found=await this.tx.query<{id:string}>(`SELECT cue.id FROM mbox.experience_plan_cues cue
      JOIN mbox.customer_experience_plans plan ON (plan.tenant_id,plan.store_id,plan.id)=(cue.tenant_id,cue.store_id,cue.experience_plan_id)
      WHERE cue.tenant_id=$1 AND cue.store_id=$2 AND cue.service_task_id=$3 AND plan.table_session_id=$4
      ORDER BY cue.id`,[...this.scope(),task.id,task.tableSessionId])
    if(found.rows.length===0)return null
    if(found.rows.length!==1)throw new ExperiencePlanLifecycleConflict()
    return this.lockByCue(found.rows[0]!.id)
  }
  assertActionable(cue:LockedExperienceCue):void {
    if(!['open','closing'].includes(cue.session_status)
      || cue.plan_state!=='active'||!['ready','dispatched'].includes(cue.status))throw new ExperiencePlanLifecycleConflict()
  }
  async complete(cue:LockedExperienceCue,input:{employeeId:string;note:string|null;task:ServiceTask|null}):Promise<void>{
    this.assertActionable(cue)
    if(cue.service_task_id!==null){
      if(input.task?.id!==cue.service_task_id||input.task.tableSessionId!==cue.table_session_id||input.task.status!=='completed')throw new ExperiencePlanLifecycleConflict()
      const proof=await this.taskCompletion(cue.service_task_id,cue.table_session_id)
      if(!proof)throw new ExperiencePlanLifecycleConflict()
      await this.completeFromProof(cue,proof,{type:'employee',employeeId:input.employeeId},false)
    } else if(cue.status!=='completed') {
      if(cue.status!=='ready'||input.task!==null)throw new ExperiencePlanLifecycleConflict()
      const changed=await this.tx.query(`UPDATE mbox.experience_plan_cues SET status='completed',completed_at=clock_timestamp(),
        completed_by_employee_id=$4,updated_at=clock_timestamp(),action_payload=action_payload||jsonb_build_object('completionNote',$5::text)
        WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='ready'`,[...this.scope(),cue.cue_id,input.employeeId,input.note])
      if(changed.rowCount!==1)throw new ExperiencePlanLifecycleConflict()
    }
    await this.finishPlan(cue,{type:'employee',employeeId:input.employeeId})
  }
  /** Worker already holds the ordered session and plan locks. This repairs only
   * proven normal completion; it cannot waive or force terminal nodes. */
  async reconcileLockedPlan(planId:string,workerId:string):Promise<void>{
    const plan=(await this.tx.query<Plan>(`SELECT plan.id,plan.table_session_id,plan.plan_state,plan.business_date::text,session.status session_status
      FROM mbox.customer_experience_plans plan JOIN mbox.table_sessions session ON (session.tenant_id,session.store_id,session.id)=(plan.tenant_id,plan.store_id,plan.table_session_id)
      WHERE plan.tenant_id=$1 AND plan.store_id=$2 AND plan.id=$3`,[...this.scope(),planId])).rows[0]
    if(!plan||plan.plan_state!=='active'||!['open','closing'].includes(plan.session_status))return
    const cues=await this.lockCues(plan.id),actor:AuditActor={type:'system',ref:workerId}
    for(const cue of cues){
      if(cue.status!=='dispatched'||!cue.service_task_id)continue
      const proof=await this.taskCompletion(cue.service_task_id,plan.table_session_id)
      if(proof)await this.completeFromProof({...plan,...cue},proof,actor,true)
    }
    await this.finishPlan(plan,actor)
  }
  private scope(){return [this.tx.scope.tenantId,this.tx.scope.storeId]}
  private async lockPlan(planId:string,sessionId:string):Promise<Plan>{
    await this.tx.query('SELECT id FROM mbox.table_sessions WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',[...this.scope(),sessionId])
    const plan=(await this.tx.query<Plan>(`SELECT plan.id,plan.table_session_id,plan.plan_state,plan.business_date::text,session.status session_status
      FROM mbox.customer_experience_plans plan JOIN mbox.table_sessions session ON (session.tenant_id,session.store_id,session.id)=(plan.tenant_id,plan.store_id,plan.table_session_id)
      WHERE plan.tenant_id=$1 AND plan.store_id=$2 AND plan.id=$3 AND plan.table_session_id=$4 FOR UPDATE OF plan`,[...this.scope(),planId,sessionId])).rows[0]
    if(!plan)throw new ExperiencePlanLifecycleConflict()
    return plan
  }
  private async lockCues(planId:string){
    return (await this.tx.query<{cue_id:string;status:string;service_task_id:string|null}>(`SELECT id cue_id,status,service_task_id FROM mbox.experience_plan_cues
      WHERE tenant_id=$1 AND store_id=$2 AND experience_plan_id=$3 ORDER BY id FOR UPDATE`,[...this.scope(),planId])).rows
  }
  private async taskCompletion(taskId:string,sessionId:string){
    return (await this.tx.query<{event_id:string;employee_id:string;note:string|null;completed_at:string}>(`SELECT event.id event_id,event.actor_employee_id employee_id,event.note,task.completed_at::text
      FROM mbox.service_tasks task
      JOIN LATERAL(SELECT id,actor_employee_id,note FROM mbox.service_task_events event
        WHERE (event.tenant_id,event.store_id,event.service_task_id)=(task.tenant_id,task.store_id,task.id)
          AND event.event_type='task.completed' AND event.to_status='completed' AND event.actor_type='employee'
          AND event.actor_employee_id IS NOT NULL ORDER BY event.occurred_at,event.id LIMIT 1) event ON true
      WHERE task.tenant_id=$1 AND task.store_id=$2 AND task.id=$3 AND task.table_session_id=$4
        AND task.status='completed' AND task.completed_at IS NOT NULL FOR SHARE OF task`,[...this.scope(),taskId,sessionId])).rows[0]
  }
  private async completeFromProof(cue:LockedExperienceCue,proof:{event_id:string;employee_id:string;note:string|null;completed_at:string},actor:AuditActor,historical:boolean){
    const updated=await this.tx.query(`UPDATE mbox.experience_plan_cues SET status='completed',completed_at=$4::timestamptz,
      completed_by_employee_id=$5,updated_at=clock_timestamp(),action_payload=action_payload||jsonb_build_object('completionNote',$6::text)
      WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status IN ('ready','dispatched')`,[...this.scope(),cue.cue_id,proof.completed_at,proof.employee_id,proof.note])
    if(updated.rowCount===0)return
    const facts:JsonObject={cueId:cue.cue_id,serviceTaskId:cue.service_task_id,originalTaskEventId:proof.event_id,originalCompletedAt:proof.completed_at,originalCompletedByEmployeeId:proof.employee_id,historicalRecovery:historical}
    await appendAuditEvent(this.tx,{actor,action:'customer.experience.cue.task_completed',objectType:'experience_plan_cue',objectId:cue.cue_id,businessDate:cue.business_date,afterData:facts})
    await appendOutboxMessage(this.tx,{businessEventKey:`experience-cue-task-completed:${cue.cue_id}`,aggregateType:'experience_plan_cue',aggregateId:cue.cue_id,aggregateVersion:1,eventType:'customer.experience.cue.task_completed.v1',payload:facts})
  }
  private async finishPlan(plan:Plan,actor:AuditActor){
    const changed=await this.tx.query(`UPDATE mbox.customer_experience_plans plan SET plan_state='completed',completed_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE plan.tenant_id=$1 AND plan.store_id=$2 AND plan.id=$3 AND plan.plan_state='active'
        AND EXISTS(SELECT 1 FROM mbox.experience_plan_cues cue WHERE (cue.tenant_id,cue.store_id,cue.experience_plan_id)=(plan.tenant_id,plan.store_id,plan.id))
        AND NOT EXISTS(SELECT 1 FROM mbox.experience_plan_cues cue WHERE (cue.tenant_id,cue.store_id,cue.experience_plan_id)=(plan.tenant_id,plan.store_id,plan.id) AND (cue.status<>'completed' OR cue.completed_at IS NULL))`,[...this.scope(),plan.id])
    if(changed.rowCount!==1)return
    const facts:JsonObject={planId:plan.id,tableSessionId:plan.table_session_id,status:'completed',completionBasis:'all_cues_completed'}
    await appendAuditEvent(this.tx,{actor,action:'customer.experience.plan.completed',objectType:'customer_experience_plan',objectId:plan.id,businessDate:plan.business_date,afterData:facts})
    await appendOutboxMessage(this.tx,{businessEventKey:`experience-plan-completed:${plan.id}`,aggregateType:'customer_experience_plan',aggregateId:plan.id,aggregateVersion:1,eventType:'customer.experience.plan.completed.v1',payload:facts})
  }
}
