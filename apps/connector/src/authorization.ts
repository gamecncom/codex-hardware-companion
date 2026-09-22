export interface TaskRefLike {
  projectId?: string;
  threadId?: string;
  connectorId?: string;
}

/** Grants are scoped to the complete frozen TaskRef, never just a thread id. */
export function taskRefMatches(a: TaskRefLike, b: TaskRefLike): boolean {
  return Boolean(a.projectId && a.threadId && a.connectorId) &&
    a.projectId === b.projectId && a.threadId === b.threadId && a.connectorId === b.connectorId;
}

export function hasAuthorizedGrant(grants: readonly TaskRefLike[], target: TaskRefLike): boolean {
  return grants.some((grant) => taskRefMatches(grant, target));
}
