# Route reference (generated)

Generated from controller metadata - 148 routes. Do not edit by hand: `npm run docs:routes`.

| Method | Path | Authentication | Handler |
|---|---|---|---|
| GET | `/health/live` | public (rate-limited / token-checked in service) | HealthController.live |
| GET | `/health/ready` | public (rate-limited / token-checked in service) | HealthController.ready |
| GET | `/metrics` | public (rate-limited / token-checked in service) | HealthController.prom |
| GET | `/v1/admin/audit` | staff + 2FA | AdminController.auditLog |
| GET | `/v1/admin/audit/verify` | staff (super_admin) + 2FA | AdminController.verifyAudit |
| GET | `/v1/admin/compliance/consents` | staff + 2FA | AdminController.consents |
| GET | `/v1/admin/compliance/deletion-jobs` | staff + 2FA | AdminController.jobs |
| POST | `/v1/admin/compliance/deletion-jobs/:id/run` | staff (super_admin) + 2FA | AdminController.runJob |
| GET | `/v1/admin/compliance/incidents` | staff + 2FA | AdminController.incidents |
| POST | `/v1/admin/compliance/incidents` | staff + 2FA | AdminController.createIncident |
| GET | `/v1/admin/compliance/incidents/:id` | staff + 2FA | AdminController.incident |
| PATCH | `/v1/admin/compliance/incidents/:id` | staff + 2FA | AdminController.updateIncident |
| GET | `/v1/admin/compliance/rights-requests` | staff + 2FA | AdminController.rights |
| GET | `/v1/admin/compliance/rights-requests/:id/access-report` | staff (super_admin) + 2FA | AdminController.accessReport |
| POST | `/v1/admin/compliance/rights-requests/:id/advance` | staff + 2FA | AdminController.advance |
| GET | `/v1/admin/compliance/vendors` | staff + 2FA | AdminController.vendors |
| PUT | `/v1/admin/compliance/vendors` | staff (super_admin) + 2FA | AdminController.vendor |
| GET | `/v1/admin/dashboard` | staff + 2FA | AdminController.dashboard |
| GET | `/v1/admin/events` | staff + 2FA | AdminController.events |
| GET | `/v1/admin/events/:id` | staff + 2FA | AdminController.event |
| POST | `/v1/admin/events/:id/archive` | staff (super_admin) + 2FA | AdminController.archive |
| POST | `/v1/admin/events/:id/grant` | staff (super_admin) + 2FA | AdminController.grant |
| DELETE | `/v1/admin/events/:id/legal-hold` | staff (super_admin) + 2FA | AdminController.release |
| POST | `/v1/admin/events/:id/legal-hold` | staff (super_admin) + 2FA | AdminController.hold |
| PATCH | `/v1/admin/events/:id/ops` | staff (super_admin) + 2FA | AdminController.ops |
| POST | `/v1/admin/events/:id/restore` | staff (super_admin) + 2FA | AdminController.restore |
| POST | `/v1/admin/events/:id/suspend` | staff (super_admin) + 2FA | AdminController.suspend |
| POST | `/v1/admin/events/:id/unsuspend` | staff (super_admin) + 2FA | AdminController.unsuspend |
| GET | `/v1/admin/kpis` | staff + 2FA | AdminController.kpis |
| GET | `/v1/admin/media-access` | staff + 2FA | AdminController.mediaAccess |
| POST | `/v1/admin/media-access` | staff + 2FA | AdminController.requestAccess |
| POST | `/v1/admin/media-access/:id/approve` | staff (super_admin) + 2FA | AdminController.approveAccess |
| POST | `/v1/admin/media-access/:id/deny` | staff (super_admin) + 2FA | AdminController.denyAccess |
| GET | `/v1/admin/media-access/:id/media` | staff + 2FA | AdminController.accessMedia |
| POST | `/v1/admin/media-access/:id/revoke` | staff (super_admin) + 2FA | AdminController.revokeAccess |
| POST | `/v1/admin/moderation/media/:id/action` | staff + 2FA | AdminController.mediaAction |
| GET | `/v1/admin/moderation/reports` | staff + 2FA | AdminController.reports |
| GET | `/v1/admin/moderation/signals` | staff + 2FA | AdminController.signals |
| POST | `/v1/admin/ops/lifecycle-tick` | staff (super_admin) + 2FA | AdminController.tick |
| POST | `/v1/admin/ops/maintenance` | staff (super_admin) + 2FA | AdminController.maint |
| GET | `/v1/admin/organizations` | staff + 2FA | AdminController.orgs |
| POST | `/v1/admin/organizations` | staff (super_admin) + 2FA | AdminController.createOrg |
| PATCH | `/v1/admin/organizations/:id/verification` | staff (super_admin) + 2FA | AdminController.verifyOrg |
| GET | `/v1/admin/payments/callbacks` | staff + 2FA | AdminController.callbacks |
| GET | `/v1/admin/payments/invoices` | staff + 2FA | AdminController.invoices |
| GET | `/v1/admin/payments/orders` | staff + 2FA | AdminController.orders |
| POST | `/v1/admin/payments/orders/:id/refund` | staff (super_admin) + 2FA | AdminController.refund |
| POST | `/v1/admin/payments/reconcile` | staff (super_admin) + 2FA | AdminController.reconcile |
| GET | `/v1/admin/payments/reconciliation` | staff + 2FA | AdminController.recon |
| GET | `/v1/admin/payments/refunds` | staff + 2FA | AdminController.refunds |
| POST | `/v1/admin/payments/refunds/:id/confirm` | staff (super_admin) + 2FA | AdminController.confirmRefund |
| POST | `/v1/admin/payments/refunds/:id/fail` | staff (super_admin) + 2FA | AdminController.failRefund |
| GET | `/v1/admin/plans` | staff + 2FA | AdminController.plans |
| PATCH | `/v1/admin/plans/:code` | staff (super_admin) + 2FA | AdminController.plan |
| GET | `/v1/admin/settings` | staff + 2FA | AdminController.settingsList |
| PUT | `/v1/admin/settings/:key` | staff (super_admin) + 2FA | AdminController.setSetting |
| GET | `/v1/admin/storage` | staff + 2FA | AdminController.storage |
| POST | `/v1/admin/storage/orphan-scan` | staff (super_admin) + 2FA | AdminController.orphan |
| GET | `/v1/admin/support/tickets` | staff + 2FA | AdminController.tickets |
| PATCH | `/v1/admin/support/tickets/:id` | staff + 2FA | AdminController.ticket |
| GET | `/v1/admin/users` | staff + 2FA | AdminController.users |
| POST | `/v1/admin/users/:id/status` | staff (super_admin) + 2FA | AdminController.userStatus |
| POST | `/v1/auth/2fa/enroll` | staff + 2FA | AuthController.enroll |
| POST | `/v1/auth/2fa/verify` | staff + 2FA | AuthController.verifyMfa |
| POST | `/v1/auth/logout` | host/collaborator access token | AuthController.logout |
| POST | `/v1/auth/refresh` | public (rate-limited / token-checked in service) | AuthController.refresh |
| POST | `/v1/auth/request-otp` | public (rate-limited / token-checked in service) | AuthController.requestOtp |
| POST | `/v1/auth/verify-otp` | public (rate-limited / token-checked in service) | AuthController.verifyOtp |
| GET | `/v1/c/:code` | public (rate-limited / token-checked in service) | MediaController.cover |
| POST | `/v1/dev/sandbox/pay` | public (rate-limited / token-checked in service) | PaymentsController.sandboxPay |
| GET | `/v1/events` | host/collaborator access token | EventsController.list |
| POST | `/v1/events` | host/collaborator access token | EventsController.create |
| GET | `/v1/events/:id` | host/collaborator access token | EventsController.get |
| PATCH | `/v1/events/:id` | host/collaborator access token | EventsController.update |
| POST | `/v1/events/:id/activate-trial` | host/collaborator access token | PaymentsController.trial |
| POST | `/v1/events/:id/archive` | host/collaborator access token | EventsController.archive |
| POST | `/v1/events/:id/cancel-deletion` | host/collaborator access token | EventsController.cancelDeletion |
| POST | `/v1/events/:id/close` | host/collaborator access token | EventsController.close |
| PUT | `/v1/events/:id/cover` | host/collaborator access token | EventsController.cover |
| POST | `/v1/events/:id/delete` | host/collaborator access token | EventsController.del |
| GET | `/v1/events/:id/exports` | host/collaborator access token | ExportsController.list |
| POST | `/v1/events/:id/exports` | host/collaborator access token | ExportsController.create |
| POST | `/v1/events/:id/extend` | host/collaborator access token | EventsController.extend |
| GET | `/v1/events/:id/folders` | host/collaborator access token | EventsController.folders |
| POST | `/v1/events/:id/folders` | host/collaborator access token | EventsController.createFolder |
| POST | `/v1/events/:id/guests/:sid/block` | host/collaborator access token | MediaController.block |
| GET | `/v1/events/:id/insights` | host/collaborator access token | EventsController.insights |
| POST | `/v1/events/:id/live-ticket` | host/collaborator access token | EventsController.liveTicket |
| GET | `/v1/events/:id/media` | host/collaborator access token | MediaController.hostMedia |
| GET | `/v1/events/:id/media-senders` | host/collaborator access token | MediaController.hostSenders |
| GET | `/v1/events/:id/members` | host/collaborator access token | EventsController.members |
| POST | `/v1/events/:id/members` | host/collaborator access token | EventsController.invite |
| DELETE | `/v1/events/:id/members/:memberId` | host/collaborator access token | EventsController.removeMember |
| GET | `/v1/events/:id/moderation` | host/collaborator access token | MediaController.queue |
| POST | `/v1/events/:id/moderation/bulk` | host/collaborator access token | MediaController.bulk |
| GET | `/v1/events/:id/moderation/logs` | host/collaborator access token | MediaController.logs |
| GET | `/v1/events/:id/payments` | host/collaborator access token | PaymentsController.forEvent |
| POST | `/v1/events/:id/qr` | host/collaborator access token | EventsController.qr |
| GET | `/v1/events/:id/reports` | host/collaborator access token | MediaController.reports |
| POST | `/v1/events/:id/restore` | host/collaborator access token | EventsController.restore |
| POST | `/v1/events/:id/secrets/rotate` | host/collaborator access token | EventsController.rotate |
| GET | `/v1/events/:id/share-links` | host/collaborator access token | EventsController.shareLinks |
| POST | `/v1/events/:id/uploads/intents` | host/collaborator access token | MediaController.memberIntent |
| GET | `/v1/events/:token/context` | public (rate-limited / token-checked in service) | GuestController.context |
| POST | `/v1/events/:token/join` | public (rate-limited / token-checked in service) | GuestController.join |
| POST | `/v1/events/:token/verify` | public (rate-limited / token-checked in service) | GuestController.verify |
| GET | `/v1/exports/:id/download` | host/collaborator access token | ExportsController.download |
| GET | `/v1/exports/:id/file` | public (rate-limited / token-checked in service) | ExportsController.file |
| GET | `/v1/exports/:id/status` | host/collaborator access token | ExportsController.status |
| DELETE | `/v1/folders/:id` | host/collaborator access token | EventsController.deleteFolder |
| PATCH | `/v1/folders/:id` | host/collaborator access token | EventsController.updateFolder |
| POST | `/v1/guest/analytics` | guest session | GuestController.track |
| GET | `/v1/guest/folders` | guest session (scope: gallery) | MediaController.guestFolders |
| POST | `/v1/guest/live-ticket` | guest session (scope: gallery) | MediaController.guestTicket |
| GET | `/v1/guest/me` | guest session | GuestController.me |
| GET | `/v1/guest/media` | guest session (scope: gallery) | MediaController.guestMedia |
| DELETE | `/v1/guest/media/:id` | guest session | MediaController.guestDelete |
| GET | `/v1/guest/media/:id/download-link` | guest session (scope: gallery) | MediaController.downloadLink |
| POST | `/v1/guest/refresh` | guest session | GuestController.refresh |
| GET | `/v1/guest/senders` | guest session (scope: gallery) | MediaController.guestSenders |
| POST | `/v1/guest/uploads/intents` | guest session (scope: upload) | MediaController.guestIntent |
| GET | `/v1/live` | public (rate-limited / token-checked in service) | MediaController.live |
| GET | `/v1/m/:id/:variant` | public (rate-limited / token-checked in service) | MediaController.media |
| DELETE | `/v1/media/:id` | host/collaborator access token | MediaController.remove |
| PATCH | `/v1/media/:id` | host/collaborator access token | MediaController.patch |
| POST | `/v1/media/:id/approve` | host/collaborator access token | MediaController.approve |
| POST | `/v1/media/:id/block-uploader` | host/collaborator access token | MediaController.blockByMedia |
| POST | `/v1/media/:id/complete` | public (rate-limited / token-checked in service) | MediaController.complete |
| POST | `/v1/media/:id/hide` | host/collaborator access token | MediaController.hide |
| POST | `/v1/media/:id/reject` | host/collaborator access token | MediaController.reject |
| POST | `/v1/media/:id/report` | host token or guest session | MediaController.report |
| POST | `/v1/media/:id/restore` | host/collaborator access token | MediaController.restore |
| GET | `/v1/payments/:orderId/status` | host/collaborator access token | PaymentsController.status |
| POST | `/v1/payments/callbacks/:provider` | public (rate-limited / token-checked in service) | PaymentsController.callback |
| POST | `/v1/payments/orders` | host/collaborator access token | PaymentsController.createOrder |
| GET | `/v1/plans` | public (rate-limited / token-checked in service) | PaymentsController.plans |
| GET | `/v1/policies/:kind` | public (rate-limited / token-checked in service) | PrivacyController.policy |
| POST | `/v1/privacy/requests` | public (rate-limited / token-checked in service) | PrivacyController.create |
| GET | `/v1/privacy/requests/:ref` | public (rate-limited / token-checked in service) | PrivacyController.inspect |
| POST | `/v1/reports/:id/escalate` | host/collaborator access token | MediaController.escalate |
| GET | `/v1/sessions` | host/collaborator access token | AuthController.sessions |
| DELETE | `/v1/sessions/:id` | host/collaborator access token | AuthController.revoke |
| POST | `/v1/sessions/revoke-others` | host/collaborator access token | AuthController.revokeOthers |
| GET | `/v1/support/tickets` | host/collaborator access token | SupportController.mine |
| POST | `/v1/support/tickets` | host/collaborator access token | SupportController.create |
| DELETE | `/v1/uploads/:id` | public (rate-limited / token-checked in service) | MediaController.cancel |
| GET | `/v1/uploads/:id` | public (rate-limited / token-checked in service) | MediaController.status |
| PUT | `/v1/uploads/:id/chunks/:n` | public (rate-limited / token-checked in service) | MediaController.chunk |
