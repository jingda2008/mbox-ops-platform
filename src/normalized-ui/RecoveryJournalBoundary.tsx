import {Component,type ComponentType,type ReactNode} from 'react'
import {RecoveryJournalError} from './recovery-journal'
class JournalBoundary extends Component<{children:ReactNode},{error:RecoveryJournalError|null}>{
  state:{error:RecoveryJournalError|null}={error:null}
  static getDerivedStateFromError(error:unknown){if(!(error instanceof RecoveryJournalError))throw error;return {error}}
  render(){return this.state.error?<div role="alert"><p>{this.state.error.message}</p><p>请返回原业务列表核对处理记录。核对前请保留此设备上的原操作记录。</p></div>:this.props.children}
}
export function withRecoveryJournalBoundary<P extends object>(View:ComponentType<P>):ComponentType<P>{
  return function GuardedRecovery(props:P){return <JournalBoundary><View {...props}/></JournalBoundary>}
}
