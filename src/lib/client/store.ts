// ============================================================================
// FlowControl — Client state store (Zustand)
//
// Holds the session, the active view (the app is a single-route SPA on "/"),
// the selected document for the detail view, and polled notification state.
// ============================================================================

import { create } from 'zustand'
import type { NotificationDTO, SessionUserDTO } from '@/types/flowcontrol'

export type ViewKey =
  | 'dashboard'
  | 'my-requests'
  | 'request-detail'
  | 'approvals'
  | 'approval-history'
  | 'notifications'
  | 'delegations'
  | 'audit'
  | 'reports'
  | 'admin'

type FlowControlState = {
  user: SessionUserDTO | null
  setUser: (user: SessionUserDTO | null) => void

  view: ViewKey
  documentId: string | null
  /** Navigate to a view; optionally carrying a document id (detail view). */
  navigate: (view: ViewKey, documentId?: string) => void
  openDocument: (documentId: string) => void

  notifications: NotificationDTO[]
  unreadCount: number
  setNotifications: (items: NotificationDTO[], unreadCount: number) => void

  /** Bump to signal data refresh after mutations (lists refetch). */
  dataVersion: number
  bumpData: () => void
}

export const useFlowControlStore = create<FlowControlState>((set) => ({
  user: null,
  setUser: (user) => set({ user }),

  view: 'dashboard',
  documentId: null,
  navigate: (view, documentId) => set({ view, documentId: documentId ?? null }),
  openDocument: (documentId) => set({ view: 'request-detail', documentId }),

  notifications: [],
  unreadCount: 0,
  setNotifications: (items, unreadCount) => set({ notifications: items, unreadCount }),

  dataVersion: 0,
  bumpData: () => set((s) => ({ dataVersion: s.dataVersion + 1 })),
}))
