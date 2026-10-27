# Goldberg 0.11 — Privacy launch operations and retention (REVIEW DRAFT)

Status: **proposed operational policy; NOT adopted, NOT legal clearance, NOT permission to enable public routes**. Prepared October 27, 2026 from Stage 6 branch `2f0cf0b6a17eeeb7d916ab170e84e9998cc99e83`. This file is a review artifact only; do not treat its creation or an eventual merge as owner approval.

## Public-facing choice and safeguards

- Project/developer pseudonym: **stokonn**.
- Public support/privacy email: **stokonn.us@gmail.com** (owner-selected).
- Do not publish the owner's legal name, home address, date of birth, or other private identifying information without separate authorization. Do not guess them.
- **Unresolved legal gate:** the identity and contact information of the actual data controller must meet Article 13 GDPR. A pseudonym plus mailbox is not automatically sufficient; the lawfulness of an individual minor acting as the contracting operator, and appropriate parent/guardian involvement, must be checked before public activation. Do not misrepresent this as resolved.
- Never place personal data, support emails, screenshots of user journals, or secrets in a public issue, commit, or evidence bundle.

## Current known technical processing (based on Stage 6 review)

- Planned public service: read-only `GET /v1/catalogue/overlay` and `GET /v1/catalogue/changes`. No community submissions, auth, admin, Google backend OAuth, profile sync, or practice-data upload.
- Cloudflare Workers receives HTTPS requests (including IP/network metadata and headers). Cloudflare Hyperdrive forwards database queries over TLS to a restricted Supabase PostgreSQL catalogue role. Database origin is Frankfurt; this does **not** guarantee that all operational processing is confined to the EU.
- Private synthetic hosted catalogue reads reportedly returned 200; publication projection was empty as of source review. Public routes were disabled. No live public routing or licence-cleared catalogue contents verified here.
- The Stage 6 review reports Worker persisted application/invocation logs and traces disabled, and Supabase PostgreSQL connection/disconnection logging off, `log_statement=ddl`, `log_min_error_statement=error`. The operator must re-check configuration in the actual deployment before launch.
- Even with app-level logging disabled, infrastructure providers can have separate security/account/operational logs; don't claim “zero logs” or “IP never processed.”

## Retention proposal for records controlled directly by Goldberg

| Category | Purpose | Proposed retention | Real-world implementation and limitations |
| --- | --- | --- | --- |
| Local practice journal, repertoire, profile, drafts | Offline functionality, user recovery | Until user edits/deletes or uninstalls; preserved recovery copies may remain until separate removal | Do not promise deletion of separate exports, user-chosen document providers or restore snapshots. Existing app behavior must be verified. |
| Read-only catalogue requests received by Worker | Return requested public music records and prevent misuse | Do **not** add an operator-maintained per-user request log or database row. Process in memory for request lifetime. | Re-check the actual Worker; provider-controlled processing and logs remain separate. |
| Support/privacy mailbox at `stokonn.us@gmail.com` | Reply to inquiries and rights requests | **Proposed:** delete routine correspondence 90 days after the request/case is closed; review at least monthly. | Owner must approve and implement a real Gmail label/review/deletion procedure. Legal holds or documented disputes may justify longer limited retention. Gmail trash and provider copies follow Google's rules; do not promise immediate worldwide erasure. |
| Rights-request register, if needed | Demonstrate handling deadlines without exposing messages | **Proposed:** record only date received, case ID, category, action, completion date and deletion date; keep the minimum time necessary under an approved schedule | Keep this register access-restricted and **not** in the public GitHub repo. Do not build it before owner selects a secure storage method. |
| Backups/export files outside app | User-chosen backup/recovery | Controlled by user and document provider | Goldberg cannot remotely delete user files at independent providers. |
| Catalogue metadata published in database | Supply licensed public music catalogue | Until corrected, removed or licence/operational policy requires deletion | No personal practice data in catalogue; field/source/licence/attribution approval must precede ingest. |

**Important:** “90 days” above is a proposed policy choice for Goldberg-controlled routine **support emails only**. It is not an existing retention setting, does not apply to infrastructure logs and must not be represented as active until owner adopts and operates it.

## External provider logs, retention and transfers

**Cloudflare**
- Cloudflare Customer DPA v6.4 (effective April 3, 2026) covers subprocessors and EEA transfers using applicable safeguards including EU standard contractual clauses. Applicability to this customer's actual account/contract must be established.
- Cloudflare Workers Logs docs currently list 3 days' queryable retention on Free for **enabled Workers Logs** (subject to provider change); Stage 6's Worker application logging is reported disabled. This figure **cannot** be used as the deletion deadline for all Cloudflare network/security/platform records.
- Cloudflare announced Observability pricing/retention changes from December 1, 2026. Keep logs and paid integrations off for the 0 CZK objective; verify Free allowances before public deployment. No upgrades without owner authorization.
- References: https://www.cloudflare.com/cloudflare-customer-dpa/ ; https://developers.cloudflare.com/workers/observability/logs/workers-logs/ ; https://developers.cloudflare.com/observability/pricing/

**Supabase**
- Supabase DPA version August 1, 2026 states the contract's data-processing framework, subprocessors and SCC provisions. Supabase also cautions that a selected project region does not imply all subprocessors/support metadata stay in that region.
- A plan's **log visibility window** and DPA provisions for deletion after **contract termination** do not prove the retention/deletion of all internal operational/security records during ordinary service use.
- Obtain/record account-applicable plan, agreement applicability, logs settings, subprocessor information and any deployment-specific retention statements; request provider clarification through official privacy channels if necessary. Do not invent a number or claim personal-log deletion on a fixed schedule without evidence.
- References: https://supabase.com/legal/customer-resources/data-processing-addendum ; https://supabase.com/legal/privacy-resources/data-residency-and-transfers-faq ; https://supabase.com/docs/guides/observability/logs

**Google / support mailbox**
- Support requests disclose sender address and message to Gmail and the sender's provider. A Goldberg mailbox cleanup procedure does not determine Google-controlled copies or security retention.
- Reference: https://policies.google.com/privacy

## Proposed rights-request operational procedure (owner adoption required)

1. Review `stokonn.us@gmail.com` regularly; tag relevant cases privately, not in GitHub. Record receipt date and minimal case reference.
2. Acknowledge and investigate without unnecessary delay. GDPR requests are generally answered **within one month of receipt**, subject to lawful extensions and exceptions. Do not assume every support email is a GDPR request.
3. Request only strictly necessary extra identity verification, never passwords, tokens or complete practice journals by default.
4. Determine whether Goldberg actually holds the requested personal data. Purely local practice records cannot be accessed, exported or erased remotely by the operator.
5. If provider-held information is implicated, route through the appropriate verified processor process; document outcome without uploading sensitive correspondence to the public repository.
6. Reply with the legally appropriate information/action, refusal grounds or extension notice where applicable. Escalate uncertain rights/legal matters to appropriate adult/legal review.
7. After closure, apply the approved correspondence retention schedule with a monthly review and documented exceptions. Before stating “90 days” as policy, actually establish a deletion workflow.

Reference: https://commission.europa.eu/law/law-topic/data-protection/information-business-and-organisations/dealing-requests-individuals_en

## Legal basis matrix — candidates, NOT legal findings

| Operation | Candidate basis to evaluate | Verification required |
| --- | --- | --- |
| Minimal catalogue request delivery and security processing of necessary connection metadata | Article 6(1)(f), legitimate interests in service availability/security, **only if** a documented necessity and balancing assessment supports it; alternatively another demonstrably applicable basis | Confirm actual processing, legitimate-interests assessment, reasonable user expectations and minors' interests; document legal review. |
| Responding to a personal data rights request | Article 6(1)(c) where processing is necessary to comply with an applicable legal obligation | Confirm controller applicability and duty for the specific request. |
| Routine voluntary support correspondence | Article 6(1)(f) may be assessed for responding to requests; other basis where demonstrably applicable | Document necessity, balance and procedure; do not automatically label all support correspondence “consent.” |
| User-initiated third-party provider media/search calls | Case-specific, based on actual app behavior and provider relationships | Verify Android consent/media controls and notices. |

References: GDPR Article 6 and Article 13, https://eur-lex.europa.eu/eli/reg/2016/679/oj ; EU data-subject rights guidance, https://commission.europa.eu/law/law-topic/data-protection/information-business-and-organisations/dealing-requests-individuals_en

## Launch gates — remain OPEN until independently evidenced

- [ ] Owner approves **exact final** `docs/PRIVACY.md` and matching Android asset, after any revisions. Remove “review copy” wording only after approval.
- [ ] Confirm lawful public controller identification and authority to operate/accept provider terms, including age/guardian review where necessary; protect the developer's private identity.
- [ ] Owner adopts and implements support mailbox retention/deletion and rights-request procedure, with honest external-provider exceptions.
- [ ] Verify applicable Cloudflare/Supabase DPA, international transfers, plan, subprocessor and account-specific log-retention facts, with links/evidence; unresolved items remain explicitly marked.
- [ ] Approve catalogue source/field/licence/attribution policy **before** importing/publishing any records. Empty catalogue is not a functioning populated music library.
- [ ] Independent private and then deliberately authorized public read-only route security/negative tests, no authentication, no writes, no admin, no practice data. Validate 0 CZK/no paid service and Free quotas.
- [ ] Owner separately approves public routing. No Android release or main merge merely from this document.

## Scope and handoff

This **review draft** may be used to inform a legal/technical revision. It intentionally does not change existing `docs/PRIVACY.md`, the bundled Android privacy asset, deployment settings, database tables or credentials. Do not auto-merge while the Stage 6 coding agent is working; reconcile with their later commits first.