# @hk/contracts/sync

What an offline device sends up, and what it pulls down. Shared by the mobile and desktop apps and
by the server.

## Commands, not rows

A device does not sync rows. It sends **commands**: "this use case ran, with this input". The
server runs the same use case again, with the command's id as the idempotency key, so a command
pushed twice is applied once.

```ts
interface SyncCommand<Payload> {
  commandId: string; // UUID v7 from the device; also the Idempotency-Key
  deviceId: string;
  tenantId: string;
  businessId: string;
  branchId: string;
  userId: string;
  useCase: 'pos.completeSale'; // <product>.<useCase>
  version: number; // payload schema version
  occurredAt: string; // device clock
  baseCursor: string; // change-feed position the device had
  payload: Payload; // checked by the use case's own schema
}
```

- `parseSyncCommand(input)` checks the envelope. The payload is checked later by its use case, on
  the device and again on the server.
- `parseSyncPushRequest(input)` checks a batch: at most 100 commands, all from one device and one
  business, none twice. Order is the order the device ran them.

## Results

Each command gets one of:

| Status                     | Meaning                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `applied`                  | The server did exactly what the device did.                                        |
| `applied_with_adjustments` | Applied, with differences listed: a final document number, stock gone negative.    |
| `rejected`                 | Not applied. `reason` is an error code the device translates and shows for review. |

## The change feed

`ChangeFeedPage` is a page of `ChangeRecord`s (`upsert` with the row, or `delete`) plus the cursor
to continue from. `parseChangeFeedPage` checks a page on the device before it is applied. A device
ignores a change whose `version` is older than what it has.

## Not here

The sync engine itself (`libs/client/sync-engine`), the server endpoint (`core/sync-hub`) and the
conflict rules belong to later rows. This lib is only the shapes they agree on.
