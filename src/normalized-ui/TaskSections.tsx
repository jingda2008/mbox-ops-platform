import { useStaffViewState } from './staff-view-state'
import { useEffect, useId, useState, type ReactNode } from 'react'

/** Lazy first visit, then keep each workspace's filters and unfinished inputs. */
export function TaskSections({ label, sections }: { label: string; sections: { id: string; label: string; content: ReactNode; visible?: boolean }[] }) {
  const available = sections.filter(section => section.visible !== false)
  const scope = useId()
  const [selected, setSelected] = useStaffViewState(`${window.location.pathname}:section:${label}`, () => {
    const requested = new URLSearchParams(window.location.hash.slice(1)).get('work')
    return available.find(section => section.id === requested)?.id ?? available[0]?.id ?? ''
  })
  const [visited, setVisited] = useState(() => new Set([selected]))
  const availableIds=available.map(section=>section.id).join('|')
  useEffect(() => {
    const restore = () => {
      const id = new URLSearchParams(window.location.hash.slice(1)).get('work')
      if (id && availableIds.split('|').includes(id)) { setSelected(id); setVisited(previous => new Set([...previous, id])) }
    }
    restore()
    window.addEventListener('hashchange', restore)
    window.addEventListener('popstate', restore)
    return () => { window.removeEventListener('hashchange', restore); window.removeEventListener('popstate', restore) }
  }, [availableIds, setSelected])
  useEffect(() => {
    if (availableIds.split('|').includes(selected)) return
    const next = availableIds.split('|')[0] ?? ''
    setSelected(next)
    setVisited(previous => new Set([...previous, next]))
  }, [availableIds, selected, setSelected])
  if (available.length === 0) return null
  return <section className="staff-task-sections" aria-label={label}>
    <nav className="staff-task-section-nav" aria-label={label}>{available.map(section => <button type="button" key={section.id} aria-current={selected === section.id ? 'page' : undefined} aria-controls={`${scope}-${section.id}`} onClick={() => {
      setSelected(section.id); setVisited(previous => new Set([...previous, section.id]))
      const hash = new URLSearchParams(window.location.hash.slice(1)); hash.set('work', section.id)
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#${hash}`)
    }}>{section.label}</button>)}</nav>
    {available.filter(section => visited.has(section.id)).map(section => <div key={section.id} id={`${scope}-${section.id}`} hidden={selected !== section.id}>{section.content}</div>)}
  </section>
}
