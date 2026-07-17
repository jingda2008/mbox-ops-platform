import type {
  PublicReservationCreateInput,
  PublicReservationCancelInput,
  PublicReservationListResponse,
  PublicReservationSessionResponse,
  PublicReservationUpdateInput,
  PublicReservationView,
} from './shared/public-reservation-contracts'

const SESSION_KEY = 'mbox.public-reservation.token'

async function parse<T>(response: Response) {
  const body = await response.json() as T & { message?: string }
  if (!response.ok) throw new Error(body.message ?? '预约服务暂时不可用')
  return body
}

async function createSession() {
  const response = await fetch('/api/public/reservation-session', { method: 'POST' })
  const session = await parse<PublicReservationSessionResponse>(response)
  window.localStorage.setItem(SESSION_KEY, session.accessToken)
  return session.accessToken
}

async function sessionToken(forceNew = false) {
  if (!forceNew) {
    const existing = window.localStorage.getItem(SESSION_KEY)?.trim()
    if (existing) return existing
  }
  return createSession()
}

async function request<T>(path: string, init?: RequestInit, retried = false): Promise<T> {
  const token = await sessionToken(retried)
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init?.body) headers.set('Content-Type', 'application/json')
  const response = await fetch(path, { ...init, headers })
  if (response.status === 401 && !retried) {
    window.localStorage.removeItem(SESSION_KEY)
    return request<T>(path, init, true)
  }
  return parse<T>(response)
}

export function listPublicReservations() {
  return request<PublicReservationListResponse>('/api/public/reservations')
}

export function createPublicReservation(input: PublicReservationCreateInput) {
  return request<PublicReservationView>('/api/public/reservations', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function updatePublicReservation(reservationId: string, input: PublicReservationUpdateInput) {
  return request<PublicReservationView>(`/api/public/reservations/${encodeURIComponent(reservationId)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}

export function cancelPublicReservation(reservationId: string, input: PublicReservationCancelInput) {
  return request<PublicReservationView>(`/api/public/reservations/${encodeURIComponent(reservationId)}`, {
    method: 'DELETE',
    body: JSON.stringify(input),
  })
}
