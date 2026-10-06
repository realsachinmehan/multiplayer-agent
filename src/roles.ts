/**
 * What each person may do in a session.
 * - viewer: watch.
 * - member: also suggest, drive when handed the wheel, claim it, pause.
 * - maintainer: also approve risky actions and change roles.
 * The session's creator is a maintainer; everyone else starts as a member.
 */
export type Role = "viewer" | "member" | "maintainer";

export const ROLES: readonly Role[] = ["viewer", "member", "maintainer"];

export function atLeast(role: Role, min: Role): boolean {
  return ROLES.indexOf(role) >= ROLES.indexOf(min);
}

export const DEFAULT_ROLE: Role = "member";

/** When a tool call needs someone's sign-off before it runs. */
export type ApprovalPolicy = {
  minRole: Role;
  // false means the person the agent is acting for can't approve their own
  // request: a second person has to look.
  allowSelf: boolean;
  reason: string;
};
