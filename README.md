# Vlad Outreach MCP

A local Claude Desktop extension for identifying KrispWork prospects, discovering KrispCX/KrispAPI opportunities, researching personalized icebreakers, and creating short email drafts. It never sends email or contacts other teams.

**Public tools: `find_leads` and `draft_email` only.** Research, enrichment, local email checks, company deduplication, priority marking and handoffs run internally through these two workflows.

## Install in Claude Desktop

The same bundle supports macOS and Windows. End users do not need Node.js, npm, Git, terminal commands, a hosted server, or any research service or API key.

1. Get [`vlad-outreach-mcp.mcpb`](release/vlad-outreach-mcp.mcpb) from the person distributing this project.
2. In Claude Desktop, open **Settings > Desktop app > Extensions > Manage > Advanced settings > Install Extension...**. Older layouts use **Settings > Extensions**.
3. Select the bundle and follow the installation prompts.
4. Optionally choose a **Working folder** in the extension settings. Leave it empty to use `Outreach MCP` in your home folder.
5. Enable the extension in your conversation, give Claude a leads CSV (its full path, or attach the file) and ask it to audit or find leads.

Claude Desktop supplies the Node runtime. This is a local desktop extension, not a URL connector for claude.ai. Your organization's policies may restrict custom extension installation. Private updates are installed manually through the same flow; saved dataset files remain outside the extension.

### Updating an existing installation

Build or obtain the latest `vlad-outreach-mcp.mcpb`, then install it through the same extension settings. Keep the same Working folder so the extension reuses saved data; giving Claude the same CSV path as before reopens its existing dataset. Reconnect the extension or restart Claude Desktop to refresh tool discovery.

Confirm that this extension lists only `find_leads` and `draft_email`. If the old helper tools still appear, check whether an older extension or manual registration is also enabled; disable that older registration. Installing this package does not change other MCP servers or remove your dataset folders.

If the installed copy has a higher version number (such as 1.12.0), remove it first, because Claude Desktop may treat 1.0.0 as a downgrade. Saved datasets live in the Working folder, outside the extension.

Version **1.0.0 needs no credentials and no required settings**. The leads file is no longer chosen at install time: Claude passes it with each tool call, so one installation works with any number of CSVs. There are no API-key fields, no model selection and no OpenAI calls. If an older installation still asks for a Leads CSV or API keys, replace it with the new bundle and restart Claude Desktop.

Local filtering, company selection, auditing, regex email checks, saved fit/priority labels and downloadable result files work without credentials. **Research is done by Claude.** When a draft needs company research, or a lead is missing a name, title, headcount or usable email, the extension asks Claude to research it with its own web search and page-reading tools. Claude submits the quotes it found, the extension downloads each cited page itself and keeps only quotes that appear there word for word. Contact corrections stay proposals until you approve them. Claude therefore needs web search/fetch enabled in the conversation.

### If Claude says the extension timed out or is not installed

This bundle is a **local Claude Desktop extension**, not a remote account connector. Install it in Desktop's Extensions settings and use that desktop app; it does not appear automatically in browser chats. Organization policies may also control local extensions. A chat message about account connectors is not proof that this local extension is missing or broken.

Version 1.0.0 registers `find_leads` and `draft_email` immediately and opens no files at startup. Each tool call opens its dataset with a 20-second deadline and closes it when the call finishes. Missing or invalid paths produce a tool error for that call only; fix the path and call again, no restart needed.

For a timeout:

1. Install the latest bundle and restart Claude Desktop. Disable an older duplicate/manual registration if present.
2. Give Claude an existing CSV on this computer and make sure the Working folder is writable. Download cloud-only files first.
3. Check the extension logs in Desktop settings. A successful launch logs `Vlad Outreach MCP: protocol ready` plus the Node/platform version. Errors from individual tool calls are returned to Claude in the chat.
4. If it still fails, share the extension error lines and say whether it failed during enabling, `find_leads`, or `draft_email`. Do not share private CSV contents or credentials.

The startup improvements are tested with protocol versions 2024-11-05, 2025-03-26 and 2025-11-25, including discovery before access to an unavailable file. They do not establish the cause of every Claude UI/account error.

## Typical workflow in Claude

You can ask Claude in natural language, for example:

> Use C:\Users\me\Documents\leads.csv. Audit it, identify repeated companies, and show the best KrispWork contact at each company. Research the companies I select, mark regional top leads, and list any KrispCX or KrispAPI handoffs. Show evidence before applying contact corrections or drafting emails.

Only **two MCP tools** are exposed to Claude: `find_leads` and `draft_email`. Auditing, email checks, enrichment, correction application, company research, company selection and handoff generation are internal helpers, not separate discoverable or callable MCP tools.

### Getting Claude to use the extension

When it connects, the extension sends Claude instructions that Claude Desktop includes in every conversation where the extension is enabled. They tell Claude to use `find_leads` and `draft_email` for any request to find, rank, audit, research or email KrispWork, KrispCX or KrispAPI leads, including "top N leads" from an attached CSV, instead of analysing the file itself or searching the web. The tool descriptions start with the same wording.

If Claude still answers without the tools:

- Check that you are in the Claude Desktop app and that **Vlad Outreach MCP** is enabled in that conversation's tools menu. A new chat may have it switched off.
- Attach the file in the same message, or give its path, rather than asking first whether Claude can do it.
- Name the extension when needed, e.g. "Use Vlad Outreach MCP to get the top 10 KrispWork leads from the attached CSV."

For "top N leads, then draft emails", Claude is told to call `find_leads` with `limit: N`, show the ranked list and then draft an email for each lead in rank order.

### Seeing what it is doing

Claude says one short line before each step (reading the file, researching a company, "Drafting 3 of 10"). Each tool also sends progress updates, where the client shows them, writes a start line without contact names to the extension log, and returns a plain-language `activity` line in its result.

### Choosing the leads file

Every call names its CSV with exactly one of:

| Argument | Use |
|---|---|
| `leads_csv` | Absolute path to a CSV on this computer (`~` is expanded). Preferred. |
| `leads_csv_content` | The CSV text, for a file attached in chat that has no local path (up to 5 MB). Optional `leads_csv_name` names the dataset. |
| `dataset_id` | The `dataset_id` returned by an earlier call. Use it for follow-up calls on the same file. |

Every result includes `dataset_id`. Different files get separate datasets, so lead IDs, research and corrections never mix. Attached content is saved once as an unchanging copy; sending identical content again reopens the same dataset, while edited content starts a new one.

### Sessions close after every call

A tool call opens its dataset, does its work and closes it again before returning. The dataset lock is held only while the call runs, so between calls the files are free for other tools: another Claude conversation or a spreadsheet opening `leads.enriched.csv`. Calls on the same dataset in one session run one after another. A call that finds the dataset busy in another process waits up to 10 seconds, then reports that it is in use. A lock left behind by a crashed process is detected and reclaimed automatically.

### Find and prepare leads

Start locally, with no research:

```json
{"leads_csv": "C:/Users/me/Documents/leads.csv", "limit": 100}
```

The examples below omit the file argument; in practice add `"dataset_id": "<from the previous result>"`.

Pass that to `find_leads`. It returns one best Work contact per company, **ranked by company score, then contact score** (with `rank`, `company_score`, `contact_score` and their reasons), local email checks, data-quality findings, pending correction proposals, saved company research/icebreakers, saved CX/API handoffs, `other_product_rows`, `lead_issues`, `response_sections` and `downloads_available`.

To research companies, pass `research: true` (optionally scoped by `lead_ids`):

```json
{"lead_ids": ["<lead id>"], "research": true}
```

Companies with current verified research are reused. For the rest, the response contains `research_requests` (one per company, with the identity requirement for each) and `research_instructions`. Claude researches them and calls `find_leads` again with `company_evidence`, one entry per company keyed by `lead_id` (at most 10 per call). Verified icebreakers, product fit and locations are then saved and drive top-lead markers and CX/API handoffs. Quotes that could not be verified are listed in `research_warnings` with the reason.

`lead_ids` scopes research, enrichment and data-quality detail; it does not replace the configured Work ICP or restrict the main lead list. Without it, research and enrichment target the returned selected leads.

To fix missing or unusable contact data, pass `enrich_missing: true`:

```json
{"lead_ids": ["<lead id>"], "enrich_missing": true}
```

The response contains `enrichment_requests` (per lead: known values, `fields_needed`, `fields_blocked` with reasons, and how source pages must identify the person) and `enrichment_instructions`. Claude researches them and calls `find_leads` again with `contact_evidence`, one entry per lead (at most 20 per call):

```json
{"contact_evidence": [{"lead_id": "L001", "candidates": [
  {"field": "email", "value": "leo.moreau@cloudhaven.com", "source_url": "https://www.cloudhaven.com/team",
   "excerpt": "<exact text containing the address>", "identity_explanation": "Cloudhaven team page lists Leo Moreau, VP of Sales"}
]}]}
```

Only missing fields and emails that fail local checks are researched; existing valid values are never overwritten. Every value must appear inside a verbatim quote on a downloaded page that mentions the company and, except for headcount, the person's full name or known personal email. Emails must be published literally on the page (mailto links count) and are never guessed from naming patterns. Headcount must be one exact number ("1,200 employees" becomes `1200`). Conflicting values for one field produce no proposal. Leads without a full name or usable personal email cannot have person fields researched; that reason is reported instead. Fields that already have a pending proposal are not requested again until it is approved or the lead changes. Rejections appear in `research_warnings` with their reason. Accepted values appear in `proposals`.



Corrections remain proposals until the user reviews the source evidence and approves specific IDs. Apply those approvals through `find_leads`:

```json
{"approved_proposal_ids": ["<explicitly approved proposal id>"]}
```

Do not approve proposals automatically. Unknown or stale IDs are rejected, original CSV rows are preserved, and the selection and downloadable files update after approved corrections.

### Draft an email

Call `draft_email` with:

```json
{
  "lead_id": "<selected lead id>"
}
```

`sender_name` (default `Vlad`), `offer` (an extra sentence or two) and `salutation` (Mr, Ms, Mrs, Dr or Prof) are optional. Every draft is built by seniority:

- **Senior contacts** (founders, owners, presidents, C-level, VPs, heads, directors) get the **company angle**: why their company needs Krisp, based on what the company does (its industry), e.g. "As a logistics company, FastFreight has a team that spends much of its day coordinating shipments by phone with carriers, drivers and customers."
- **Everyone else** gets the **role angle**: why they need Krisp in their own work, e.g. "As a Customer Support Agent at Acme, you likely spend most of your day on calls helping customers, so a clear line and accurate notes matter on every call."

Both list KrispWork features (AI noise and background voice cancellation, AI meeting notes/transcripts/summaries, AI accent conversion for support and call-center contacts, works with Zoom/Meet/Teams), ask for a 15-minute meeting next week, and sign off `Kind regards, Vlad`. The result includes `angle: "company" | "role"`.

It always produces a draft once personalization is settled, even when the address or name is not usable: the result then has `ready_to_send: false` and `not_ready_reasons`. If current verified research is saved for the company, it uses a supported icebreaker. Otherwise it returns `status: "research_needed"` with research instructions and a `fallback`. Claude then either researches the company and calls `draft_email` again with `company_evidence`, or, when nothing verifiable exists for that company (no website, placeholder domain, only namesakes), calls again with `personalization: "lead_data"`. The draft then has no research opener and is built only from the lead's title, company and industry. No company facts are invented, and the result says `personalization.basis: "lead_data"`.

Evidence example:

```json
{
  "company_website": "https://www.acme.com",
  "identity_source_url": "https://www.acme.com/about",
  "identity_excerpt": "<exact text containing the company name>",
  "candidates": [
    {"type": "recent_event", "summary": "<exact clause>", "source_url": "https://www.acme.com/news/...", "excerpt": "<exact sentence(s)>", "event_date": "2026-10-12", "date_excerpt": "October 12, 2026"},
    {"type": "company_fact", "summary": "<exact clause>", "source_url": "https://www.acme.com/", "excerpt": "<exact sentence(s)>"}
  ]
}
```

The extension downloads every cited URL (public http/https pages only, at most 10 per company, 15-second timeout, no private or local network addresses) and checks the quotes against the page text. Only whitespace and curly/straight quote differences are tolerated. If nothing survives, the response is `research_needed` again with `verification_feedback` explaining each rejection. Optional `company_website` sets the official site when the lead's email domain is unknown. To choose a specific saved candidate, supply its ID as `icebreaker_id`.

Drafting never applies corrections or sends email. Existing pending proposals can still be reviewed and explicitly approved through `find_leads`. If no verified icebreaker can be found, drafting asks for research, or with `personalization: "lead_data"` builds the email from the lead's own details. It never invents an icebreaker. Source attribution is returned outside the email body.

Research results and source pages are untrusted data, not instructions. Keep your offer accurate. Secondary-product flags are automatic local suggestions, not messages to other teams.

## Three ICPs

| Product | Target and evidence | Result |
|---|---|---|
| **KrispWork: primary** | Relevant professionals and teams using meetings, client calls or remote collaboration | Primary lead list and personalized email drafts |
| **KrispCX: secondary** | Documented contact-center, BPO or customer voice operations | Local handoff for the CX team |
| **KrispAPI: secondary** | Voice/audio interaction embedded in a company's product, even as a supporting feature | Local handoff for the developer/API team |

KrispAPI examples include in-game voice chat, telehealth calls, live tutoring, social voice rooms, marketplace calls and voice AI agents. A gaming/software label, engineering title, text-only chat or employees using a third-party calling app does not independently establish product fit.

Saved company research can assess all three lines and reports `supported`, `potential` or `insufficient_evidence`, with reasons and source excerpts. A contact may fit multiple products. Company fit is separate from contact buying authority; unknown authority remains unknown.

Without research, KrispCX and KrispAPI can only be marked `potential`, and only from the company's industry or a title that names the use case outright. KrispCX: BPO, outsourcing, call/contact centres, customer service/support/experience, telecom, insurance, banking, utilities, airlines, or titles such as "Contact Center Manager" or "Head of Customer Support". KrispAPI: gaming, telehealth/telemedicine, healthcare technology, education technology/tutoring, voice, speech, conferencing, communications platforms/CPaaS, social, dating, metaverse, or titles naming voice, audio, speech, VoIP or real-time communication. General titles such as COO, Head of Operations or VP of Engineering no longer create a potential flag. The reason names the industry or title used. `research_status` reports whether saved findings are current, stale or absent. Normal searches and handoff listings never request research. With `research: true`, explicit `lead_ids` can target any lead, including people outside the Work title filter.

### KrispWork defaults and editable rules

The default ICP has **no employee-count, industry or country restrictions**. Relevant individual contributors qualify alongside leaders. Functions include sales, customer support/service/success, recruiting, consulting, operations, remote work and IT, plus founders and executives. A support agent can be a lead regardless of employer size.

Edit the dataset's `icp.json`; the next search reads it without restarting. Tool arguments cannot override it.

| Setting | Behavior |
|---|---|
| `industries` | Exact case-insensitive matches; `[]` disables the filter |
| `title_keywords` | Case-insensitive substrings; CEO/COO match complete tokens; `[]` disables the filter |
| `min_headcount`, `max_headcount` | Inclusive nonnegative integer bounds; `null` disables each bound |
| `countries` | Hard filter on the CSV country, using case-insensitive exact matches; `[]` disables it |
| `priority_countries` | Research-based regional priority marker, not a hard exclusion; `[]` disables the marker |
| `priority_industries` | Call-heavy industries that add `priority_industry` points to the company score. Case-insensitive partial match, so `Logistics` also matches `Transportation & Logistics`. Not a filter. The default covers logistics and transport, BPO and contact centres, customer service, insurance, financial services, banking, lending, mortgage, fintech, recruiting, staffing, HR services, consulting, professional services, legal, accounting, real estate, telecom, travel, hospitality and healthcare/telehealth. It is also used when the key is missing; `[]` disables it |

Active filter categories combine with AND; values within a list combine with OR. Missing data excludes a lead only when an active filter needs it. Original filter keys are required; omitted `priority_countries` uses the seven defaults below for compatibility. Invalid JSON, unknown keys or inverted bounds produce an error.

Role matches indicate plausible prospects, not proven demand or purchasing authority.

### Regional top leads

Priority countries are **United States, Philippines, India, United Kingdom, Brazil, Colombia and Mexico**.

A Work ICP match receives `top_lead: true` only when fresh, source-backed research establishes a current company office or workforce in one of these countries. Results include `regional_fit`, `priority_countries_matched` and evidence in `priority_reasons`.

The CSV contact country, customers in a market, remote hiring eligibility, former offices and future openings do not qualify by themselves. Country aliases in research are normalized. Unknown evidence stays `regional_fit: "unknown"`; it does not prove the company has no operations there.

Research expires after seven days. Priority is recalculated against current rules. A top lead may still have an invalid email: geographic fit and email readiness are independent.

### Lead score and ranking

Scoring has two steps. A company is **eligible** when it passes the `icp.json` rules and has at least one contact matching them; only eligible companies are listed.

1. **Company score**: is this company worth targeting? Company facts only.
2. **Contact score**: is the contact we have there a good person to reach? The selected contact only.

Results and `lead-priorities.csv` are ranked by company score, then contact score, then company size (largest first, unknown last), then file order. A strong contact never lifts a weaker company above a stronger one. `order: "csv"` returns file order instead. Each lead shows `company_score`, `contact_score` and the reasons for each.

**Company score**

| Signal | Default points |
|---|---|
| Company size 1,000+ people | 20 |
| Company size 200-999 | 12 |
| Company size 50-199 (under 50 or unknown: 0) | 5 |
| Any of the company's contacts has a CSV country in `priority_countries` | 10 |
| Call-heavy industry: any of the company's contacts has a CSV industry matching `priority_industries` | 15 |
| Verified research: current office/workforce in a priority country (`top_lead`) | 20 |
| Verified research supports KrispWork fit | 10 |

Company size uses `company_headcount`, the largest headcount any of the company's contacts lists in the CSV.

**Contact score**

| Signal | Default points |
|---|---|
| Email ready to use (valid, not generic, not a placeholder) | 40 |
| Senior role (founder, C-level, VP, president, owner, managing director, head, director) | 25 |
| Manager role (manager, lead, supervisor) | 15 |
| Any other title matching the KrispWork rules | 10 |
| Call-heavy function (sales, customer support/success, recruiting, consulting, IT help desk) | 15 |
| First and last name present | 5 |

Change the points in the dataset's `icp.json` with an optional `scoring_weights` object. Company keys: `company_size_large`, `company_size_mid`, `company_size_small`, `priority_country`, `priority_industry`, `top_lead`, `krispwork_supported`. Contact keys: `email_ready`, `senior_role`, `manager_role`, `other_matching_role`, `call_heavy_function`, `complete_name`. Values are whole numbers 0-100; omitted keys keep the defaults. For example `"scoring_weights": {"company_size_large": 30, "email_ready": 20}`.

### One best contact per company per product

`find_leads` returns one selected Work contact per company. Results include `matching_contacts`, `unique_companies`, `selected_lead_id`, `alternative_lead_ids`, `selection_reasons` and readiness issues. With `order: "csv"`, companies keep their earliest CSV occurrence order; limits apply after grouping.

Grouping prefers researched canonical domains. Identical names are normalized for case, whitespace and punctuation and grouped when there is no conflicting corporate-domain evidence. Different contact countries do not split a multinational company. Public/placeholder domains do not establish company identity; similar names alone do not merge companies. Conflicting identities remain separate and appear in audit findings. CSV-name groups are provisional.

Among relevant contacts, selection prefers:

1. Locally usable email: valid syntax, non-generic and non-placeholder.
2. Both first and last names present.
3. Source-backed relevance of the contact to that product.
4. Relevant seniority as a tie-breaker.
5. Original CSV order as the final tie-breaker.

A ready support agent can outrank an executive with an `info@` address. CX and API may select different contacts from the same company. If nobody is ready, the strongest available contact is returned with outstanding issues. Alternatives remain in the full dataset. Corrections and new research can change the selection.

### Reply layout, other-product rows and lead issues

Every `find_leads` result carries `response_sections`, and the server instructions tell Claude to answer in that order: the ranked leads table, draft emails for the ranked leads (via `draft_email`, at most 10 unless asked for more), a separate KrispCX/KrispAPI table, suggestions, and a closing question about downloading the drafted emails.

- `other_product_rows`: every CSV row at a company with an active, stale or potential KrispCX/KrispAPI fit, not only the selected contact. Each row lists its products with `status`, `reason`, `role_match` (the row's title suits that product) and `selected_contact`. Claude always shows these as their own table under their own heading, and keeps the heading even when none are found.
- `lead_issues`: data errors and warnings across the whole file, each with `code`, `field`, `severity` and a suggested fix: missing fields, invalid/placeholder/generic/free-provider emails, emails that do not resemble the name, odd names, duplicate emails and people, and conflicting company identities. (Non-numeric headcounts and duplicate lead IDs are already rejected when the CSV is loaded.) `by_issue` counts them by code; at most 150 entries are listed. Nothing is changed; fixes still go through enrichment proposals and explicit approval.

### Secondary handoffs

Supported CX/API opportunities appear in the local handoff list with status `active`. Potential ones, suggested by industry or an explicit title (see above), appear with status `potential` and the reason in `fit.reason`. This includes companies with no KrispWork-matching contact; when no contact suits the product line, `lead_id` is null and the company's contacts are listed in `alternative_lead_ids`. `find_leads.handoffs` lists active entries first, then potential ones, with `confirmed` and `potential` counts. Potential entries never become active without research. Entries contain evidence, contact relevance, email-check status, research timestamps and alternative contacts, and are deduplicated by company/product.

The downloadable `handoffs.csv` also contains history: supported findings expire to `stale` after seven days, or become `inactive` when superseded by a successful assessment without support. Failed/ambiguous refreshes preserve prior findings at their original timestamp. If no relevant contact exists, a company-level handoff has a null lead ID for further research.

Nothing is sent to another team. The list is for manual review and handoff. Drafting remains focused on KrispWork.

## Public MCP interface

| Tool | Arguments | Behavior |
|---|---|---|
| `find_leads` | `limit?`, `order?`, `lead_ids?`, `research?`, `enrich_missing?`, `approved_proposal_ids?`, `company_evidence?`, `contact_evidence?`, `download_files?` | Deduplicated Work prospects, internal quality checks, research/enrichment requests and verified evidence intake, correction approval, saved handoffs, other-product rows, lead issues and file downloads on request |
| `draft_email` | `lead_id`, `sender_name?`, `offer?`, `salutation?`, `icebreaker_id?`, `company_website?`, `company_evidence?`, `personalization?` | Readiness checks and verified sourced personalization; returns a draft or a research request |

Both tools also name the leads file as described in [Choosing the leads file](#choosing-the-leads-file). `limit` defaults to 20 with a maximum of 100. `research` and `enrich_missing` default to false. A supplied `lead_ids` or `approved_proposal_ids` list contains 1-100 IDs; `company_evidence` holds 1-10 companies and `contact_evidence` 1-20 leads. Corrections are applied only for explicitly approved proposal IDs. `download_files` returns only the named files, and Claude sends it only after you agree. No other MCP tool names are registered; internal helpers are covered by developer tests but cannot be invoked directly by Claude.

Contact enrichment covers `first_name`, `last_name`, `email`, `title` and `headcount`. Verified values become proposals; email replacements must also pass local checks before application. `draft_email` does not stop for missing names or unusable emails; it lists them in `not_ready_reasons`, and this workflow is how to fix them.

## Email checks and drafting limits

Internal email checking is **not deliverability or ownership verification**. Results are included in `find_leads`. `draft_email` reports failures as warnings and `ready_to_send: false` rather than blocking the draft:

- `method: "regex"` and `format_status: "valid" | "invalid"` for common ASCII email syntax, including length/dot/domain checks.
- Generic-mailbox detection for addresses such as `info@`, `sales@` and `support@`, including tagged variants.
- Rejection of placeholder domains such as `.example`, `.invalid`, `.test` and reserved example domains.
- Advisory `name_pattern`: `matches`, `does_not_match` or `insufficient_name_data`. Common forms such as `jane.smith`, `janesmith` and `jsmith` are recognized with plus tags ignored.
- `deliverability: "not_checked"`, `identity: "unconfirmed"`, and non-generic mailbox type `unknown` rather than proven personal.

Name-pattern mismatches are allowed with warnings. Checks recompute from current values. Old Hunter assessments never override current local checks. No DNS, SMTP or remote email checks run.

A draft does not need a usable email or both names; those gaps become `not_ready_reasons` and `ready_to_send: false`.

Drafts are formal. The greeting is `Dear Mr Smith,` when `salutation` is passed or the name field contains one, otherwise `Dear Jane Smith,` with a warning (`Dear Jane,` / `Dear Sir or Madam,` when names are missing). The salutation is never guessed from a first name. The sign-off is `Kind regards, Vlad`. The body has fewer than 170 words, and an oversized offer produces a length error.

Names, titles and company names are tidied for the email only (capitalisation such as `JOHN` → `John`, `it manager` → `IT Manager`, extra spaces, legal suffixes such as `Inc.`/`Co`). Each change is listed in `lead_data_corrections`, and the leads file is not changed.

Every draft warns that mailbox existence, deliverability and ownership remain unverified.

Company research returns up to three icebreakers. Recent events require an actual supported event date within 90 days, not just publication timing. Otherwise, a sourced company/product fact may be used without presenting it as recent news. Sources, exact excerpts and company identity are validated; unsupported findings stay unresolved. Explicit selections are rejected if unknown, wrong-company or expired; omitting the selection selects a current saved icebreaker or asks Claude for research. Source attribution is returned outside the email body.

## Dataset files and recovery

Each CSV path gets a folder `<csv-name>-<path-hash>` inside the Working folder, and each attached file `<name>-u<content-hash>`. The folder name is the `dataset_id`. Each folder holds a `dataset.json` naming its source, plus:

| File | Contents |
|---|---|
| `icp.json` | Editable filters and priority countries |
| `leads.enriched.csv` | Complete working dataset; retains every original contact |
| `.state/state.json` | Authoritative leads, proposals, research, drafts and correction history |

Updates/reinstallation preserve dataset files. Renaming/moving a CSV changes its identity. Saved state takes precedence over later source-file edits; to import an edited original afresh, delete its dataset folder or use a new Working folder. Deleting the folder also deletes that dataset's saved drafts, so download them first. Original files are never modified.

Writes are serialized and file replacements are atomic. Startup repairs `leads.enriched.csv` from authoritative state after an interrupted write. A `.state/state.json.lock` left by a crashed process is reclaimed automatically once that process no longer exists. Dataset errors are returned with the tool call; check the path, write permissions and valid ICP JSON.

### Downloading result files

Result files are **not saved to disk**. `find_leads` lists what can be downloaded in `downloads_available`, and every reply with drafts ends with a question about downloading your drafted emails:

| Download | Contents |
|---|---|
| `drafts.md` / `drafts.csv` | Every email draft (latest per lead), readable or as a spreadsheet |
| `other-product-leads.csv` | KrispCX / KrispAPI leads, one row per contact and product line |
| `lead-priorities.csv` | Ranked KrispWork contacts with scores, reasons, regional evidence and alternatives |
| `handoffs.csv` | KrispCX/KrispAPI handoffs per company, including stale/inactive history |

Only after you say yes does Claude call `find_leads` with `download_files`. The extension returns the files to Claude (as MCP resources and in `files[]`), but a tool cannot put a download in the chat by itself, so Claude hands them over with whatever file feature your app offers. If it has none, Claude says so and shows the content in a block to copy. Drafts are kept with the dataset in `.state/state.json`, so they can be downloaded later.

## CSV format and sample data

Expected headers are:

```csv
lead_id,first_name,last_name,title,company,industry,headcount,country,email
```

Header order may vary; extra columns are rejected. IDs must be nonempty and unique. Populated headcounts must be nonnegative integers. Missing names/titles and malformed emails are retained for auditing. Parsing supports UTF-8 BOM, quoted commas, doubled quotes, embedded newlines and Windows line endings.

The supplied sample has 50 contacts across 25 company names. Current Work defaults match **34 contacts across 23 companies**; `find_leads` returns 20 companies by default. The sample also contains **49 placeholder email addresses and one malformed address**, so their drafts are produced but marked `ready_to_send: false` until the addresses are corrected. Company country fields alone do not make any sample lead a regional top lead.

## How research works

Claude Desktop extensions cannot call Claude's model or web tools on their own, so research is a hand-off: the extension tells Claude what is needed, Claude researches with its own tools, and the extension checks the result before saving it.

- The extension never trusts Claude's summary of a page. It downloads each cited URL itself and accepts only quotes found verbatim in the page text (title, description metadata and visible text; scripts and styles are ignored).
- Company identity must be proven first: identity and website must be on the lead's email domain, or on `company_website` when given, otherwise the identity quote must name the company and its country.
- Recent events need an event date within 90 days, with that date quoted from the same page. Saved research expires after seven days.
- Pages that need JavaScript or a login, redirect to another site, or are not HTML/text are rejected with a reason so Claude can cite a different page.
- Downloads go only to public internet addresses on standard ports; private, loopback and link-local addresses are refused at connection time.
- Page content is treated as untrusted data and is never followed as instructions.

## Developer build

End users only need the extension-install steps above. Development requires Node.js 24+ (`.nvmrc` selects it for nvm users); the compiled desktop bundle targets Node 20+. In Windows PowerShell, use `npm.cmd` if `npm.ps1` is blocked.

```bash
npm ci
npm run check
npm test
npm run package:desktop
```

The package command creates `release/vlad-outreach-mcp.mcpb`, validates its manifest against the official MCPB 0.3 schema and bundles runtime dependencies. The unsigned private-distribution archive includes the server, default ICP, README and third-party notices, not CSVs, keys, saved state, caches or install scripts. It does not publish to an extension directory. Distribute only the bundle.

## Validation and Part 2

Type checks and **62 automated tests** pass in the development workspace. Coverage includes original-file preservation, local email checks, role eligibility, company selection/conflicts, source-backed product/geography evidence, Claude-evidence verification against downloaded pages for company research and contact enrichment, fetch safety (private-address refusal, HTML text extraction), freshness, lead scoring and ranking (two-step company/contact scoring, call-heavy industries, custom weights, company-size tiers and the headcount tie-break), lead-data personalization, seniority-based drafts, formal greetings and lead-data tidying, drafts for not-ready contacts, handoffs, downloadable files with no disk writes, progress updates, per-call file selection (path, attached content, dataset_id), lock release after each call, waiting for and reclaiming locks. Tests extract and run the actual bundle over MCP stdio with no research keys, including arbitrary working directories and paths containing spaces. Archive integrity is independently checked.

Windows tests have run locally. macOS/Windows Node 20/22 runtime CI is configured but has not run in this workspace. The extension has been installed on Windows, and `draft_email` and `find_leads` with `download_files` have run through the installed copy. macOS operation, an end-to-end research run by Claude in Desktop, and how the Desktop chat shows the download question, status lines and progress updates remain manually unverified. Page downloading was checked against a few live public sites.

Deferred features are listed under [NOTES](#notes): Hunter-backed deliverability/identity verification, warm/cold classification, sender-domain routing, sending-provider integration, delivery monitoring, lead enrichment and company revenue.

## NOTES

### Planned features (Part 2)

Deferred features:

- Explicit warm/cold outreach classification based on relationship context.
- Configured primary sender for warm outreach and secondary-domain sender for cold outreach.
- Sending-provider integration and enforcement of routing again at send time.
- Sender authentication setup and delivery, bounce, complaint, and unsubscribe monitoring.
- Reporting based on actual provider events; delivery acceptance alone does not establish inbox placement.
- Hunter integration for mailbox deliverability, accept-all detection, provider-backed personal/generic classification, and identity evidence. Part 1 uses local regex checks only; they cannot establish mailbox existence, ownership, or deliverability.
- Lead enrichment: find the missing fields of existing leads.
- Company revenue: know how much each company earns.

Neither of the last two can be done with the current leads file. Its companies do not exist, so no research can be made for any lead, including company revenue. The `enrich_missing` workflow for contact fields is already built, but it needs real companies to find anything.

The current MCP creates drafts only. It has no sender-domain routing, outreach-type arguments, or sending behavior. Secondary-domain separation cannot guarantee complete protection of the primary domain's reputation.
