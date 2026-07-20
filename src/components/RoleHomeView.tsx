import {
  ArrowRight,
  Banknote,
  CalendarDays,
  CheckCheck,
  CircleAlert,
  ChartNoAxesCombined,
  ContactRound,
  CookingPot,
  Cpu,
  Gift,
  LayoutDashboard,
  ListTodo,
  Map as MapIcon,
  Music2,
  PackageSearch,
  Settings2,
  ShieldCheck,
  Store,
  TableProperties,
  UsersRound,
  type LucideIcon,
} from 'lucide-react'
import type { BootstrapResponse } from '../shared/contracts'
import {
  buildRoleHomeModel,
  type RoleHomeIndicator,
  type RoleHomeNavigationId,
} from './role-access'
import './RoleHomeView.css'

export interface RoleHomeViewProps {
  data: BootstrapResponse
  employeeId: string
  onNavigate: (view: RoleHomeNavigationId) => void
}

const indicatorIcons: Record<RoleHomeIndicator, LucideIcon> = {
  tables: TableProperties,
  tasks: ListTodo,
  risk: CircleAlert,
  kds: CookingPot,
  people: UsersRound,
  config: Settings2,
  payments: Banknote,
  reservations: CalendarDays,
}

const navigationIcons: Record<RoleHomeNavigationId, LucideIcon> = {
  live: LayoutDashboard,
  tasks: ListTodo,
  reservations: CalendarDays,
  commerce: CookingPot,
  inventory: PackageSearch,
  payments: Banknote,
  benefits: Gift,
  operations: ChartNoAxesCombined,
  devices: Cpu,
  songs: Music2,
  layout: MapIcon,
  master: ContactRound,
  config: Settings2,
}

export function RoleHomeView({ data, employeeId, onNavigate }: RoleHomeViewProps) {
  const model = buildRoleHomeModel(data, employeeId)
  const activeTodos = model.todos.filter((item) => item.count > 0)
  const primaryTodo = activeTodos[0]
  const remainingTodos = activeTodos.slice(1)
  const attentionByNavigation = new Map<RoleHomeNavigationId, number>()
  for (const item of activeTodos) {
    attentionByNavigation.set(item.navigationId, (attentionByNavigation.get(item.navigationId) ?? 0) + item.count)
  }

  return (
    <section className="role-home" aria-labelledby="role-home-title">
      <header className="role-home__header">
        <div className="role-home__identity">
          <span className="role-home__store"><Store size={15} aria-hidden="true" />{data.store.name}</span>
          <h2 id="role-home-title">{model.access.title}</h2>
          <p>{model.access.focusLabel}</p>
        </div>
        <div className="role-home__actor">
          <span>{model.employee?.displayName ?? '身份未识别'}</span>
          <strong>{model.access.roleLabel}</strong>
          <small>{data.store.businessDate}</small>
        </div>
        {model.access.isFallback && (
          <div className="role-home__restricted" role="status">
            <ShieldCheck size={16} aria-hidden="true" />受限岗位
          </div>
        )}
      </header>

      {primaryTodo && (
        <div className={`role-home__next-action is-${primaryTodo.tone}`} role="status">
          <span className="role-home__next-number">1</span>
          <span className="role-home__next-copy">
            <small>现在先做</small>
            <strong>{primaryTodo.label}</strong>
            <span>{primaryTodo.detail}</span>
          </span>
          <button type="button" onClick={() => onNavigate(primaryTodo.navigationId)}>
            开始处理 <b>{primaryTodo.count}</b><ArrowRight size={17} aria-hidden="true" />
          </button>
        </div>
      )}

      <div className={`role-home__metrics role-home__metrics--${Math.min(model.metrics.length, 4)}`} aria-label="岗位摘要">
        {model.metrics.map((item) => {
          const Icon = indicatorIcons[item.indicator]
          return (
            <button
              className={`role-home__metric is-${item.tone}`}
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.navigationId)}
              title={`打开${item.label}`}
            >
              <span className="role-home__metric-icon"><Icon size={19} aria-hidden="true" /></span>
              <span className="role-home__metric-copy"><strong>{item.value}</strong><small>{item.label}</small></span>
              <ArrowRight className="role-home__metric-arrow" size={16} aria-hidden="true" />
            </button>
          )
        })}
      </div>

      <div className="role-home__work-grid">
        <section className="role-home__section" aria-labelledby="role-home-todos">
          <div className="role-home__section-heading">
            <div><span>完成第一项后再看这里</span><h3 id="role-home-todos">接下来</h3></div>
            <b>{remainingTodos.reduce((sum, item) => sum + item.count, 0)}</b>
          </div>
          {remainingTodos.length === 0 ? (
            <div className="role-home__empty">
              <CheckCheck size={23} aria-hidden="true" />
              <strong>{primaryTodo ? '没有其他待办，先完成上面的事项' : '当前没有待处理事项'}</strong>
            </div>
          ) : (
            <div className="role-home__todo-list">
              {remainingTodos.map((item) => (
                <button
                  className={`role-home__todo is-${item.tone}`}
                  key={item.id}
                  type="button"
                  onClick={() => onNavigate(item.navigationId)}
                >
                  <span className="role-home__todo-count">{item.count}</span>
                  <span className="role-home__todo-copy"><strong>{item.label}</strong><small>{item.detail}</small></span>
                  <ArrowRight size={17} aria-hidden="true" />
                </button>
              ))}
            </div>
          )}
        </section>

        <nav className="role-home__section" aria-labelledby="role-home-navigation">
          <div className="role-home__section-heading">
            <div><span>{model.access.roleLabel}</span><h3 id="role-home-navigation">工作入口</h3></div>
            <b>{model.navigation.length}</b>
          </div>
          <div className="role-home__navigation">
            {model.navigation.map((item) => {
              const Icon = navigationIcons[item.id]
              const attention = attentionByNavigation.get(item.id) ?? 0
              return (
                <button key={item.id} type="button" onClick={() => onNavigate(item.id)}>
                  <span><Icon size={18} aria-hidden="true" /></span>
                  <strong>{item.label}</strong>
                  {attention > 0 && <b aria-label={`${attention}项待办`}>{attention}</b>}
                  <ArrowRight size={16} aria-hidden="true" />
                </button>
              )
            })}
          </div>
        </nav>
      </div>
    </section>
  )
}
