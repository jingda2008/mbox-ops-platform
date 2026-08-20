# M-BOX 1.0.0-rc.98

## Scope

This candidate supersedes `1.0.0-rc.97`. The `rc.97` production activation
proved that the worker adapter was inherited and mounted, but the copied
directory and module were readable only by root. The normalized application
runs as a non-root user, so the candidate failed closed before cutover. The
release rollback restored and publicly reverified the previous application.

## Runtime permission correction

- Adapter directories retain read/traverse access and adapter files retain read
  access for the non-root application user.
- Group and other write permissions remain forbidden, ownership remains root,
  symbolic links remain forbidden, and the container mount remains read-only.
- The module mode is checked for both required read bits and forbidden write
  bits before migration or provisioning.

## Acceptance boundary

This release deploys only the normalized staff web, service and database
bundle. It does not upload a WeChat mini-program package. Real payment/refund,
real-device WeChat authorization and physical inventory acceptance remain
separate evidence.
