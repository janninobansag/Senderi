import type { User } from "../../../shared";

export function SupporterBadge({ user }: { user: Pick<User, "supporterBadge" | "verifiedBadge"> }) {
  return <>
    {user.supporterBadge && (
      <span className="supporter-badge" role="img" aria-label="Owner of Senderi" title="Owner of Senderi">
        <img src="/senderi-symbol.png" alt="" />
      </span>
    )}
    {user.verifiedBadge && (
      <span className="verified-account-badge" role="img" aria-label="Verified account" title="Verified account">
        <img src="/verified-account-badge.png" alt="" />
      </span>
    )}
  </>;
}
