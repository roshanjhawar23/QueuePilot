import { createContext, useContext } from 'react';
import type { QueuePilotClient, Session } from './api/client';

export interface SessionContextValue {
  session: Session;
  client: QueuePilotClient;
  signOut: () => void;
}

export const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession must be used inside SessionContext');
  return v;
}

export function useClient(): QueuePilotClient {
  return useSession().client;
}
