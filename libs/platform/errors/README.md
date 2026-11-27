# @hk/platform/errors

One error format for every service: RFC 9457 problem details, with a stable `code`.

```json
{
  "type": "about:blank",
  "title": "Conflict",
  "status": 409,
  "code": "INVOICE_ALREADY_ISSUED",
  "detail": "The invoice is already issued.",
  "instance": "/sales/invoices/…/issue",
  "requestId": "…",
  "details": { "status": "ISSUED" }
}
```

Clients branch on `code` and translate it. `title` and `detail` are English text for developers.

| Thrown                            | Status                               |
| --------------------------------- | ------------------------------------ |
| `DomainError` kind `validation`   | 422                                  |
| `DomainError` kind `not-found`    | 404                                  |
| `DomainError` kind `conflict`     | 409                                  |
| `DomainError` kind `forbidden`    | 403                                  |
| `DomainError` kind `invariant`    | 500                                  |
| `RequestValidationError`          | 400, with an `errors` list of fields |
| `AppError(code, status, message)` | the given status                     |
| anything else                     | 500                                  |

- **A 500 never leaks.** The caller gets `INTERNAL_ERROR` plus the request and trace ids. The
  original error is in the logs.
- Business rules throw `DomainError` (from `@hk/platform/universal`). `AppError` is for transport
  and infrastructure: `unauthenticated()`, `permissionDenied()`, `notFound()`,
  `tooManyRequests(seconds)`, `serviceUnavailable()`.
- `isProblemDetails` recognises the body on the receiving side. The HTTP client uses it.
