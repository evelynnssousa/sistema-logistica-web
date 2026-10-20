export const accountStatuses = [
  'pending',
  'approved',
  'rejected',
  'blocked',
  'inactive',
] as const

export type AccountStatus = (typeof accountStatuses)[number]
export type UserRole = 'admin' | 'operator'

export const modulePermissions = [
  'maintenance:read',
  'maintenance:write',
  'fleet:read',
  'fleet:write',
  'flights:read',
  'flights:write',
  'flights:cpf:read',
  'warehouse:read',
  'warehouse:write',
  'settings:read',
  'settings:write',
] as const

export type ModulePermission = (typeof modulePermissions)[number]

export interface UserRecord {
  id: string
  fullName: string
  email: string
  sector: string
  passwordHash: string
  status: AccountStatus
  role: UserRole | null
  permissions: ModulePermission[]
  createdAt: Date
}

export type PendingUser = Omit<UserRecord, 'passwordHash'>

export interface PublicUser {
  id: string
  fullName: string
  email: string
  sector: string
  status: AccountStatus
  role: UserRole
  permissions: ModulePermission[]
}

export interface SessionRecord {
  id: string
  userId: string
  sessionTokenHash: string
  csrfTokenHash: string
  expiresAt: Date
}

export interface AuditEvent {
  actorUserId: string | null
  action: string
  targetUserId: string | null
  targetResourceId?: string | null
  result: 'success' | 'denied' | 'failure'
  details?: Record<string, string | number | boolean | null>
}

export interface RegistrationInput {
  fullName: string
  email: string
  sector: string
  password: string
}

export interface RegistrationDecision {
  action: 'approve' | 'reject'
  role?: UserRole
  permissions?: ModulePermission[]
}

export interface AuthRepository {
  createPendingUser(input: RegistrationInput & { passwordHash: string }): Promise<UserRecord>
  findUserByEmail(email: string): Promise<UserRecord | null>
  findUserById(id: string): Promise<UserRecord | null>
  createSession(input: Omit<SessionRecord, 'id'>): Promise<void>
  findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null>
  deleteSession(tokenHash: string): Promise<void>
  endSession(tokenHash: string, actorUserId: string): Promise<void>
  listPendingUsers(): Promise<PendingUser[]>
  decideRegistration(
    userId: string,
    actorUserId: string,
    decision: RegistrationDecision,
  ): Promise<UserRecord | null>
  setUserStatus(
    userId: string,
    actorUserId: string,
    status: 'blocked' | 'inactive',
  ): Promise<UserRecord | null>
  hasAdministrator(): Promise<boolean>
  hasOtherAdministrator(userId: string): Promise<boolean>
  createAuditEvent(event: AuditEvent): Promise<void>
  createInitialAdministrator(input: RegistrationInput & { passwordHash: string }): Promise<UserRecord>
}