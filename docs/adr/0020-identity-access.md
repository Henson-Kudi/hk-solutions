# ADR 0020: Access: roles, memberships and choosing a business

- **Status:** Accepted
- **Date:** 2026-11-28
- **Decided by:** Henson
- **Relates to:** ADR 0003 (tenancy and row-level security), ADR 0013 (the audit chain), ADR 0016
  (identity accounts; this is the first half of part 4), ADR 0017 (sessions)

## Context

Plan row 3.2 asks for "roles and memberships with branch scope", and section 12 says: roles are
per business, a membership can limit a role to some branches, the built-in roles are seeded, and
an external accountant can be invited to many tenants. Section 13.1 has the gateway resolve the
business and branch of each request "from the `X-Business-Id` and `X-Branch-Id` headers against
the user's memberships".

BizTrack's documents describe a different mechanism in places, and are silent in others. Where
they disagree with the plan, the plan is followed.

Part 4 of identity is delivered as two pull requests: this one, and invites.

## Decision

### Roles and memberships are the business's data, behind row-level security

`roles` and `memberships` have the tenant columns and the tenant policy, and are reached through
`ScopedRepository`. What a person may do in a business, and who works there, is that business's
data and nobody else's. Tests prove it with raw SQL: with no `WHERE` clause at all, a business
sees only its own roles, and a row written for another business is refused by the database.

### One small directory outside the businesses

"Which businesses may this person enter?" is asked before a business is chosen, and row-level
security hides every business's rows until one is. The question cannot be answered from behind
the wall.

So there is one global table, `user_businesses`: the person, the business, its tenant, and
whether the membership is active. No role, no permission, no branch.

- It is written in the same transaction as the membership it mirrors, and only for the business
  that transaction is open for. A test makes the audit log fail mid-way and checks neither was
  written.
- **It only says where to look.** `authorize` uses it to find the tenant, then opens the business
  and reads the membership itself, which is what decides. A test makes the two disagree and
  checks access is refused.

The alternative was to make memberships themselves global. It was not chosen: one wrong query
would then show one business's staff list, roles and branch limits to another.

### No second token: access is worked out for each request

BizTrack issued a token without a business at sign-in and a second, business-scoped one after
"select business"; a change of role took effect when that token expired, up to 15 minutes later.

Here the session token is about the person only (ADR 0017). `authorize(user, business, branch)`
answers, for one request, what the person may do there: tenant, role, branches and permissions.
The gateway calls it with the headers of the request, and may cache the answer briefly. A
suspension, a removal or a change of role is in force on the next request.

Anyone who is not an active member gets one answer, `IDENTITY_ACCESS_DENIED`, whether the
business does not exist, they were never a member, or they were suspended.

### Roles

- Every business gets its own copy of the eight built-in roles: Owner, Manager, Accountant,
  Cashier, Storekeeper, HR Officer, Viewer and External accountant. `provisionBusiness` creates
  them, with the owner's membership, when tenancy (row 3.3) creates a business.
- **The defaults live beside the permission registry** (`@hk/contracts/permissions`), so the pull
  request that adds a product's resources also decides which built-in roles get them. A test
  fails when a resource has no decision.
- A business may change what its copy of a built-in role grants, and add custom roles (at most 50
  roles in all). A built-in role keeps its name and cannot be deleted.
- **The owner role cannot be changed, and what is stored for it is never read.** The owner holds
  every permission in the registry, including ones added later.
- Permissions of a product the business does not have are dropped when access is worked out, for
  the owner too.

The default grants are a first proposal and are meant to be reviewed: see "Open".

### Memberships

- A person has one membership in a business, with one role. It may be limited to a list of
  branches; no list means every branch. An empty list is refused: "no branch" is a suspension.
- Status is `active`, `suspended` or `removed`. A removed member who is added again gets the same
  membership back.

### Protections

- **The owner's membership is never changed**: not the role, not the branches, and the owner
  cannot be suspended or removed, by anyone, themselves included.
- **Nobody can be made owner by being given the owner role.** A business has one owner.
- **Nobody changes their own membership.**
- **Nobody grants, or acts on, access greater than their own.** Creating or editing a role,
  giving someone a role, and suspending, removing or re-roling a member all require the actor to
  hold every permission involved. Without this, anyone allowed to edit roles could make
  themselves owner in all but name, and a junior with "manage members" could remove a manager.
- Two new permissions resources guard all this: `members` (view, invite, update, remove) and
  `roles` (view, manage). By default only the owner can change either; managers can look.

### Changes are recorded in the business's audit chain

Every change to a role or a membership writes an event to the business's audit log (ADR 0013), in
the same transaction as the change. Events carry ids and permission names, never a name or a
phone number.

## Consequences

- Three more tables need Henson's line-by-line review: `roles`, `memberships`, `user_businesses`.
  The last is listed in `ACCESS_GLOBAL_TABLES` for the tenancy check; the first two are not
  exempt and must never be.
- `memberships.user_id` and `memberships.role_id` are not foreign keys. A tenant-scoped row should
  not hold locks on the global users table, and a removed membership may outlive its role. A
  member whose role is gone is refused everywhere; a test covers it.
- Deleting a role and giving it to someone at the same instant can leave a member with a role
  that no longer exists. That member is locked out, not let in, until given another role.
- The gateway must send the business with each request and should cache `authorize` for seconds,
  not minutes.
- `core/identity/application` now depends on `core/audit/application` (for the adapter) and on the
  contracts libs.

## Open

- **The default permissions of each built-in role** are my proposal, written to be conservative: a
  cashier cannot void, refund, override a price or adjust stock; only the owner closes a period
  or manages access. They are data in one file and should be reviewed with someone who runs a
  shop.
- **Transferring ownership.** Not described by the plan or by BizTrack. Today a business keeps its
  first owner. It needs its own design: it is the one change that moves full control.
- **A limit on members by plan** (BizTrack had one). It belongs to entitlements (a later row);
  `addMember` is where it will be checked.
- **Invites** are the next pull request and end in `addMember`.
- **A business in `SETUP` is locked for non-owners** (plan row 3.3). `authorize` returns `isOwner`
  so tenancy can apply that rule.
- **The plan's `ConsolidationReader`** (reading several businesses at once, for consolidated
  reports) is not built. The directory answers "which businesses", not "read across them".
