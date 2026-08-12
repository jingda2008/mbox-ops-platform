import type {
  StaffBootstrapView,
} from '../shared/normalized-contracts'

export type WorkspacePhase = 'idle' | 'loading' | 'ready' | 'error' | 'login_required'

export interface NormalizedWorkspaceState {
  phase: WorkspacePhase
  bootstrap: StaffBootstrapView | null
  etag: string | null
  message: string | null
}

export type WorkspaceAction =
  | { type: 'bootstrap-loading' }
  | { type: 'bootstrap-ready'; bootstrap: StaffBootstrapView; etag: string | null }
  | { type: 'bootstrap-not-modified'; etag: string | null }
  | { type: 'bootstrap-error'; message: string; loginRequired: boolean }

export function initialWorkspaceState(): NormalizedWorkspaceState {
  return {
    phase: 'idle',
    bootstrap: null,
    etag: null,
    message: null,
  }
}

export function workspaceReducer(
  state: NormalizedWorkspaceState,
  action: WorkspaceAction,
): NormalizedWorkspaceState {
  switch (action.type) {
    case 'bootstrap-loading':
      return { ...state, phase: 'loading', message: null }
    case 'bootstrap-ready':
      return {
        ...state,
        phase: 'ready',
        bootstrap: action.bootstrap,
        etag: action.etag,
        message: null,
      }
    case 'bootstrap-not-modified':
      return {
        ...state,
        phase: state.bootstrap === null ? 'error' : 'ready',
        etag: action.etag,
        message: state.bootstrap === null ? '本地没有可恢复的工作台数据，请重新加载' : null,
      }
    case 'bootstrap-error':
      return {
        ...state,
        phase: action.loginRequired ? 'login_required' : 'error',
        message: action.message,
      }
  }
}
