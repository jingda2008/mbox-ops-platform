export const STAFF_VIEWPORT_CONTENT = 'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover'

export function applyStaffViewport(
  doc: Document = document,
  screenSize?: Pick<Screen, 'width' | 'height'>,
) {
  const viewport = doc.querySelector<HTMLMetaElement>('meta[name="viewport"]')
  const previousContent = viewport?.getAttribute('content') ?? null
  const view = doc.defaultView
  const width = screenSize?.width ?? view?.screen?.width ?? view?.innerWidth ?? 1024
  const height = screenSize?.height ?? view?.screen?.height ?? view?.innerHeight ?? 768
  const isPhone = Math.min(width, height) <= 767

  viewport?.setAttribute('content', STAFF_VIEWPORT_CONTENT)
  doc.documentElement.classList.add('staff-viewport')
  doc.documentElement.classList.toggle('staff-phone-device', isPhone)

  return () => {
    if (viewport) {
      if (previousContent === null) viewport.removeAttribute('content')
      else viewport.setAttribute('content', previousContent)
    }
    doc.documentElement.classList.remove('staff-viewport', 'staff-phone-device')
  }
}
