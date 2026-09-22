# Public source validation

The published source copy passed `npm run check` on Windows on 2026-09-22:

- TypeScript typecheck and build passed.
- 25 Node/stdio tests passed.
- 43 Python mock tests passed, including deterministic target selection.

No IDE was launched and no physical PLC connection was attempted by these tests.
Known rename, parameter/I/O readback and headless recovery issues remain documented
in README.md; incomplete follow-up patch drafts are not included in this repository.
CI runs the offline test suite on Windows. Vendor software and SDKs are not included.
