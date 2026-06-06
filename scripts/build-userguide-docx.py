"""
Builds Yardward-Pro-User-Guide.docx from the captured screenshots + the
in-script content definitions below.

Usage: python scripts/build-userguide-docx.py
Output: docs/Yardward-Pro-User-Guide.docx
"""

import os
from pathlib import Path
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.oxml import OxmlElement


ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "docs" / "screenshots"
OUT = ROOT / "docs" / "Yardward-Pro-User-Guide.docx"

AMBER = RGBColor(0xC2, 0x6A, 0x00)
NAVY = RGBColor(0x0E, 0x1E, 0x3D)
MUTED = RGBColor(0x6B, 0x7A, 0x90)


# ----- content tree -----------------------------------------------------------

CONTENT = [
    {
        "kind": "title",
        "text": "Yardward Pro",
        "subtitle": "Trucking & Haulage Operations CRM — User Guide",
    },
    {
        "kind": "section",
        "title": "1. Introduction",
        "paragraphs": [
            "Yardward Pro is an end-to-end operations platform for trucking and haulage companies. It replaces three separate tools — Workforce, Formstack, and Fleetio — with a single application that handles scheduling, driver workflows, vehicle management, work orders, billing, communications, and reporting.",
            "The app is delivered as a Progressive Web App (PWA), which means drivers and mechanics install it directly from a URL on their phones — no app-store download required. It works offline: forms submitted in dead zones queue locally and sync automatically when the device reconnects.",
            "There are three role-specific views that share the same backend: Admin (management), Driver (mobile-first on-site), and Mechanic (workshop). Each role sees only what they're authorized to see; data isolation is enforced at the database level by Row-Level Security policies in Supabase.",
        ],
    },
    {
        "kind": "section",
        "title": "2. Getting started",
        "paragraphs": [
            "Open https://yardward-pro.vercel.app/ (or your custom domain) in any modern browser. The sign-in page renders the same on desktop and mobile.",
        ],
        "shots": [
            ("public-01-login.png", "Sign-in page. Pick a role, enter email and password, click Sign in. The Forgot? link triggers a password-reset email."),
        ],
        "subsections": [
            {
                "title": "First-time sign-in",
                "paragraphs": [
                    "When an admin creates your account they hand you a one-time temporary password. On first sign-in:",
                    "1. Go to https://yardward-pro.vercel.app/.",
                    "2. Enter your email and the temp password.",
                    "3. Click the Forgot? link, type your email, and click Send link. You'll receive an email with a recovery link.",
                    "4. Click the link in the email. You're redirected to the Set new password page.",
                    "5. Choose a strong password (12+ characters recommended).",
                    "6. Sign in again with the new password.",
                ],
            },
            {
                "title": "Installing the mobile PWA",
                "paragraphs": [
                    "On iOS Safari: open the app URL, tap the Share button, scroll down to Add to Home Screen, give it a name (e.g. 'Yardward'), and tap Add. A Yardward icon appears on your home screen.",
                    "On Android Chrome: open the app URL, tap the three-dot menu, choose Install app or Add to Home screen.",
                    "After installing, the app launches in full-screen mode without a browser address bar. It updates automatically when admins push new releases.",
                ],
            },
        ],
    },
    {
        "kind": "section",
        "title": "3. Admin guide",
        "paragraphs": [
            "Admins manage the whole operation. The admin shell has a left sidebar with 17 tabs grouped roughly by operational concern.",
        ],
        "subsections": [
            {
                "title": "3.1. Dashboard",
                "shots": [("admin-01-dashboard.png", "The admin landing page shows a KPI strip, today's schedule, an embedded live vehicle map preview, and a recent-activity feed.")],
                "paragraphs": [
                    "Use the dashboard as your daily morning check. The KPIs at the top summarize the operational state (active drivers, scheduled jobs, work orders awaiting approval, etc.). The Recent activity panel pulls from the notifications table — new form submissions, job updates, and approvals stream in live.",
                ],
            },
            {
                "title": "3.2. Schedule",
                "shots": [("admin-02-schedule.png", "Weekly schedule grid. Rows are drivers, columns are weekdays. Each cell is either an assigned job card (status-colored border) or a + button for quick-add.")],
                "paragraphs": [
                    "Click + in an empty {driver, weekday} cell to open the Create Job dialog with the driver and date pre-filled. Drag a job card to reassign. Click an existing card to edit details, add notes, or change status (Draft / Published / Completed / Delayed / Cancelled).",
                    "When you publish a job, Yardward sends an SMS to the assigned driver via Twilio with the job summary and location. Drafts are private to admins until published.",
                ],
            },
            {
                "title": "3.3. Jobs",
                "shots": [("admin-03-jobs.png", "All jobs across all dates with status filter. Click any row to open the detail sheet with full job context, GPS map, notes, and linked work order if submitted.")],
                "paragraphs": [
                    "Use the search box to find jobs by client, address, or driver name. The status filter pills (All / Pending / In Progress / Completed) narrow the list. Each row opens a side-sheet with the job's full lifecycle.",
                ],
            },
            {
                "title": "3.4. Drivers & mechanics",
                "shots": [("admin-04-drivers.png", "Driver + mechanic roster shown as cards with avatar, name, status, phone (E.164 format), and license info. Pencil icon opens a Sheet to edit the phone.")],
                "paragraphs": [
                    "The yellow banner at the top counts placeholder phone numbers. Drivers without valid E.164 phones won't receive SMS via Twilio — set their real numbers using the pencil icon on each card.",
                    "Click Add driver to onboard a new driver: enter name, email, phone, license number, and license expiry. Yardward creates the auth account, generates a one-time temp password, and shows it to you in a Copy credentials panel — hand it to the new driver. They should use Forgot? on first sign-in to rotate.",
                    "To onboard a mechanic, go to Settings → Users → Invite user, pick role = Mechanic, and enter their details.",
                ],
            },
            {
                "title": "3.5. Vehicles",
                "shots": [("admin-05-vehicles.png", "Fleet roster. Each card shows the vehicle ID, year, type, assigned driver, odometer, engine hours, last service, and next service due.")],
                "paragraphs": [
                    "Click Add vehicle to register a new truck or piece of equipment. Use the Fleetio import button to bulk-import from a Fleetio export — it accepts vehicles, maintenance history, and fuel logs.",
                    "Click any vehicle to open its detail page with maintenance history, fuel log, assigned tools, and an embedded GPS map showing its current location from Geotab.",
                ],
            },
            {
                "title": "3.6. Live vehicle map",
                "shots": [("admin-06-live-map.png", "Real-time map of every vehicle in the fleet, pulled from Geotab. Markers are color-coded by status (operational, in maintenance, out of service). Sidebar lists vehicles with last-seen times.")],
                "paragraphs": [
                    "The map auto-refreshes every 30 seconds. Click a marker to see vehicle ID, driver, last-seen time, and a deep link to the vehicle detail page. Click a sidebar row to recenter the map.",
                    "If GPS is unavailable for a vehicle, the marker uses the last known position. The status color tells you whether it's an operational truck, in the shop, or out of service.",
                ],
            },
            {
                "title": "3.7. Work orders",
                "shots": [("admin-07-work-orders.png", "Submitted work orders awaiting management review. Each row shows the job, driver, client, weight tonnes, dump site, status, and submitted time.")],
                "paragraphs": [
                    "When a driver completes a job, they submit a work order via the mobile app with foreman signature, weight, dump location, GPS check-in, and any notes. The work order lands here for management review.",
                    "Click any work order to review the full submission. Use Approve to authorize invoicing — Yardward auto-generates the QuickBooks invoice draft based on the client's rate table. Use Reject with a reason if the work order is incomplete or disputed.",
                ],
            },
            {
                "title": "3.8. Communications",
                "shots": [("admin-08-communications.png", "Three-way driver↔mechanic↔admin messaging tracked end-to-end via Twilio. Left rail: thread list with filter chips (Tagged me / Joined / All). Right pane: selected thread with messages + compose.")],
                "paragraphs": [
                    "Communications is the central inbox for every conversation between drivers, mechanics, and admins. Drivers and mechanics start threads about specific topics (general / job / vehicle / maintenance). Admins always have read-everything visibility but only get notifications and reply ability when they're explicitly tagged by someone or self-join a thread.",
                    "Default filter is Tagged me — only threads where you're an active participant. Switch to Joined to see threads you've self-joined, or All to observe every conversation in the org.",
                    "Outbound messages are delivered via the configured channel: in-app participants get realtime updates, drivers and mechanics on phones get real SMS via Twilio. They can reply by text and the reply lands in the same thread within seconds. MMS attachments (photos) work end-to-end.",
                ],
            },
            {
                "title": "3.9. Timesheets",
                "shots": [("admin-09-timesheets.png", "All clock-in / clock-out events for the week, with GPS cross-reference against Geotab vehicle movement. Flagged rows highlight mismatches (e.g. driver clocked in but truck never moved).")],
                "paragraphs": [
                    "Yardward cross-references every clock event with Geotab vehicle telemetry. Mismatches (clock-in without truck movement, prolonged stops, driver punching in from outside GPS tolerance) are flagged automatically.",
                    "Click Export to QuickBooks to push the week's approved hours into QBO Payroll. The push uses the QBO_REFRESH_TOKEN configured in your project secrets.",
                ],
            },
            {
                "title": "3.10. SMS log",
                "shots": [("admin-10-sms-log.png", "Every SMS dispatched through Twilio with delivery status. Use this as an audit log when drivers claim they didn't receive a job assignment.")],
                "paragraphs": [
                    "Each row shows the recipient driver, job context, message body, Twilio message ID, and delivery status (queued / sent / delivered / failed). A green Live indicator highlights messages sent in the last 60 seconds.",
                ],
            },
            {
                "title": "3.11. Purchase orders",
                "shots": [("admin-11-purchase-orders.png", "PO requests from mechanics awaiting management approval. Each shows the item, requested quantity, cost estimate, and whether the item is already in stock.")],
                "paragraphs": [
                    "When a mechanic needs a part, they submit a PO request. Yardward first checks the parts inventory — if stock exists, the system suggests pulling from inventory instead of ordering. If approval is needed, the PO lands here.",
                    "Click Approve to authorize purchase. Click Mark ordered when the PO has been placed with the supplier. Use Reject with a reason to deny.",
                ],
            },
            {
                "title": "3.12. Prepaid tickets",
                "shots": [("admin-12-prepaid-tickets.png", "Per-client prepaid ticket balances. Use this when clients buy tickets in bulk (e.g. 100 tickets at a flat rate) and drivers pull tickets per load.")],
                "paragraphs": [
                    "Each row shows the client, current balance, threshold for low-balance alert, bundle size, bundle price, and auto-billing status. When a client's balance hits the threshold, Yardward triggers a replenishment invoice draft.",
                ],
            },
            {
                "title": "3.13. Clients",
                "shots": [("admin-13-clients.png", "Client roster with contact info and rate tables.")],
                "paragraphs": [
                    "Each client has a custom rate table — different unit prices for different load types or vehicle types. The rate table feeds invoice generation automatically when a work order is approved.",
                    "Click New client to add. Click a client row to edit their contact info, rate table line items, prepaid ticket settings, or notes.",
                ],
            },
            {
                "title": "3.14. Forms & submissions",
                "shots": [("admin-14-forms.png", "Centralized inbox for every form a driver submits: pre-trip inspections, tool checklists, work orders, start-of-day, end-of-day, job logs, ticket photos.")],
                "paragraphs": [
                    "Use the tab pills to filter by form type. Each submission shows the driver, vehicle (where applicable), timestamp, GPS coordinates if captured, and a Resolve button if the submission is informational.",
                    "Click a submission row to open the full detail sheet with all answers, attached photos, signature (if collected), and the GPS map of where it was submitted.",
                ],
            },
            {
                "title": "3.15. Tenders",
                "shots": [("admin-15-tenders.png", "Aggregated tender feed scraped from municipal portals (Halton region by default). Each row is a posted contract opportunity.")],
                "paragraphs": [
                    "Yardward runs a scraper every Monday at 06:00 UTC against configured tender sources. New tenders land here automatically. Click Run scraper now to fire it on demand. Click Send test digest to email the weekly digest (requires RESEND_API_KEY).",
                ],
            },
            {
                "title": "3.16. Error log",
                "shots": [("admin-16-errors.png", "Every error captured server-side, with severity, source, code, and stack. Use this when investigating customer reports of weird behavior.")],
                "paragraphs": [
                    "Errors are auto-captured from React error boundaries, Edge Function failures, RPC errors, and webhook handlers. Use Mark resolved to clear the row after you've addressed the underlying cause. Use the Dead-letter queue tab to inspect form submissions that exhausted their retry budget and need manual replay.",
                ],
            },
            {
                "title": "3.17. Reports",
                "shots": [("admin-17-reports.png", "Operational reports: hours summary, vehicle utilization, revenue by client, flagged events, etc.")],
                "paragraphs": [
                    "Each card opens a detailed report with charts. Use the date-range picker on each report to focus on a billing period or compare months. Click Export PDF to generate a printable version for sharing.",
                ],
            },
            {
                "title": "3.18. Settings",
                "shots": [("admin-18-settings.png", "Tabbed settings for Organization profile, System thresholds (GPS tolerance, overtime alerts, inspection min/max), Integrations (QBO, Twilio, Geotab, Fleetio, Resend), Users, Notifications, Billing, and Driver tokens.")],
                "paragraphs": [
                    "Organization tab: business name, tax ID, address, timezone, currency. These render across the dashboard header and invoices.",
                    "System thresholds tab: GPS tolerance minutes (used for clock-in / Geotab cross-check), overtime warning and alert hours, inspection min/max duration.",
                    "Integrations tab: connect / disconnect QuickBooks Online, view Twilio + Geotab status, configure Fleetio import, set up Resend SMTP for the tender digest.",
                    "Users tab: lists every active user. Use Invite user to onboard a new admin, driver, or mechanic — the dialog returns a temp password you hand off.",
                    "Notifications tab: org-wide notification preferences (which event types fire emails or SMS).",
                    "Billing tab: subscription plan, renewal date, seats used, vehicles active. Use Cancel subscription to request cancellation through support.",
                    "Driver tokens tab: generate a tokenized one-time link to a specific form (e.g. /driver/tickets) that a driver can open on any device without signing in. Useful for one-off site visits.",
                ],
            },
        ],
    },
    {
        "kind": "section",
        "title": "4. Driver guide (mobile)",
        "paragraphs": [
            "The driver view is mobile-first — large tap targets, minimal text input, and offline-tolerant. A bottom navigation bar with 6 tabs handles every workflow.",
        ],
        "subsections": [
            {
                "title": "4.1. Home",
                "shots": [("driver-01-home.png", "Today's assigned jobs, clock-in / clock-out button, GPS status badge, and quick links to forms.")],
                "paragraphs": [
                    "The home screen is your morning check-in: today's jobs, clock-in button, GPS status indicator (green = active, amber = fallback mode, gray = pending), and shortcuts to the most-used forms.",
                ],
            },
            {
                "title": "4.2. My jobs",
                "shots": [("driver-02-jobs.png", "Today's and upcoming jobs assigned to you, sorted by scheduled time.")],
                "paragraphs": [
                    "Tap any job to see the full details: client, address, scheduled time, vehicle assigned, notes from dispatch, and a Submit work order button that takes you to the work-order form pre-filled with the job context.",
                ],
            },
            {
                "title": "4.3. Forms",
                "shots": [("driver-03-forms.png", "Tile menu for all driver forms: Start of day, Tool checklist, Vehicle inspection, Job log, Work order, End of day.")],
                "paragraphs": [
                    "Tap any tile to open the form. Most forms capture GPS automatically and timestamp the submission. Forms submitted without an internet connection queue on the device and sync as soon as you're back online.",
                ],
            },
            {
                "title": "4.4. Start of day",
                "shots": [("driver-04-start-of-day.png", "Clock-in form: vehicle selected, GPS captured, optional notes.")],
                "paragraphs": [
                    "Start of day clocks you in. The form captures the time, the selected vehicle, and a GPS location for cross-reference against Geotab. You must complete the vehicle inspection (pre-trip) within 12 hours of clocking in — otherwise the system will lock you out of submitting work orders until you do.",
                ],
            },
            {
                "title": "4.5. Tool checklist",
                "shots": [("driver-05-tool-checklist.png", "Per-truck tool inventory check. Toggle each tool to OK or Flag. Damaged or missing tools require a note and notify management.")],
                "paragraphs": [
                    "Run the tool checklist at the start of each shift. Any tool flagged as missing or damaged triggers a Communications notification to admin and mechanic. The driver cannot complete End of day without a passing tool checklist.",
                ],
            },
            {
                "title": "4.6. Vehicle inspection",
                "shots": [("driver-06-inspection.png", "Pre-trip safety inspection: tyres, lights, brakes, fluid levels, signage, etc. Photo capture for any flagged item.")],
                "paragraphs": [
                    "Required by CVOR. Tap each item to mark OK or flag with a required note + photo. The inspection auto-saves drafts, so if you lose signal mid-form your progress is preserved.",
                    "A passing inspection unlocks the 12-hour drive window. If anything is flagged red, the form blocks submission until you've added a note explaining the defect and taken a photo.",
                ],
            },
            {
                "title": "4.7. Job log",
                "shots": [("driver-07-job-log.png", "Free-form job notes during a shift. Add timestamps, voice notes (with transcription), or photos. Anchored to the current job.")],
                "paragraphs": [
                    "Use the job log to record any incident: delay reasons, client disputes, equipment issues, customer interactions. Each entry is timestamped + GPS-tagged automatically.",
                ],
            },
            {
                "title": "4.8. Work order",
                "shots": [("driver-08-work-order.png", "On-site work-order submission: load type, weight tonnes, dump site, foreman signature pad, photos, GPS check-in.")],
                "paragraphs": [
                    "Complete this form at the end of each delivery. The form requires:",
                    "- Load type (selected from a dropdown configured per-client)",
                    "- Weight tonnes (manual entry; integrates with scale-house tickets in Phase 2)",
                    "- Dump site (auto-populated from job + editable)",
                    "- Foreman signature (drawn on the touchscreen)",
                    "- Photo of the delivered load (optional but recommended)",
                    "- GPS check-in (automatic)",
                    "Once submitted, the work order goes to admin for approval. After approval the invoice draft auto-generates against the client's rate table.",
                ],
            },
            {
                "title": "4.9. End of day",
                "shots": [("driver-09-end-of-day.png", "Clock-out form: end-of-shift tool checklist, fuel level, odometer, vehicle return location.")],
                "paragraphs": [
                    "End of day clocks you out for the day. The form requires a passing end-of-shift tool checklist and an odometer reading for fuel reconciliation. After submission, you're done — your timesheet entry lands in admin's Timesheets tab.",
                ],
            },
            {
                "title": "4.10. Tickets",
                "shots": [("driver-10-tickets.png", "Record a prepaid ticket pull for a client. Pick the client, enter the qty, optionally attach a photo of the paper ticket.")],
                "paragraphs": [
                    "Use this when clients pay in prepaid tickets (e.g. ticket books for waste hauling). The driver pulls a ticket per load, records it here, and the client's balance auto-decrements. When balance hits the configured threshold, admin gets a low-balance notification.",
                ],
            },
            {
                "title": "4.11. Messages",
                "shots": [("driver-11-messages.png", "Driver's view of Communications. Mobile-first thread list + full-screen conversation Sheet.")],
                "paragraphs": [
                    "Tap New to start a conversation with a mechanic. Pick the recipient, set the topic (general / job / vehicle / maintenance), enter the subject, and start typing. Tap @ to tag an admin into the thread if you need their input.",
                    "Messages flow over real Twilio SMS — even when you're outside the app, the mechanic still gets a text and can reply by SMS. Their reply lands back in this thread within seconds.",
                ],
            },
            {
                "title": "4.12. Profile",
                "shots": [("driver-12-profile.png", "Your profile: name, license info, current shift status, notification preferences, change password, help & support.")],
                "paragraphs": [
                    "Tap Change password to fire a reset link to your email. Tap Notifications to opt in/out of specific notification channels. Tap Help & support to see FAQ and open a support ticket to admin.",
                ],
            },
        ],
    },
    {
        "kind": "section",
        "title": "5. Mechanic guide",
        "paragraphs": [
            "The mechanic view focuses on the workshop queue: maintenance work orders, PO requests, vehicle maintenance logs, and parts inventory.",
        ],
        "subsections": [
            {
                "title": "5.1. Workshop dashboard",
                "shots": [("mechanic-01-dashboard.png", "Active work orders assigned to you, with vehicle, issue, priority, and reporter. Plus a quick PO request form.")],
                "paragraphs": [
                    "The dashboard is your queue. Active work orders are at the top. Use the inline PO request form to submit a parts request — Yardward checks the inventory first and suggests pulling from stock if available.",
                ],
            },
            {
                "title": "5.2. Work orders queue",
                "shots": [("mechanic-02-work-orders.png", "All maintenance work orders sorted by priority then by created date. Tap Claim to assign one to yourself.")],
                "paragraphs": [
                    "MWOs are auto-generated from flagged vehicle inspections and admin-created tickets. Tap any unclaimed MWO to Claim it (becomes assigned to you). Once claimed, the row moves to your active queue.",
                    "While working, update the MWO with parts used, labor hours, and notes. When finished, tap Complete to close it out. The vehicle's last-service and next-due dates update automatically.",
                ],
            },
            {
                "title": "5.3. Messages",
                "shots": [("mechanic-03-messages.png", "Mechanic's view of Communications. Threads with drivers default to the driver assigned to your most recent MWO.")],
                "paragraphs": [
                    "Same Communications surface as drivers. When you start a New conversation, the recipient picker defaults to the driver who reported your most recent MWO — the most common case.",
                ],
            },
            {
                "title": "5.4. Purchase requests",
                "shots": [("mechanic-04-purchase-requests.png", "Your submitted PO requests with status: pending, approved, ordered, rejected.")],
                "paragraphs": [
                    "Submit PO requests here. Each row shows the item, requested qty, cost estimate, status, and admin's notes if rejected. When admin approves, the row updates and the part is allocated for ordering.",
                ],
            },
            {
                "title": "5.5. Maintenance logs",
                "shots": [("mechanic-05-maintenance.png", "All maintenance work performed on every vehicle. Use this as the historical record for compliance and warranty claims.")],
                "paragraphs": [
                    "Each row shows the vehicle, date, type of maintenance, parts used, labor hours, and the mechanic who performed the work. Click any row to see full details including the originating MWO if one existed.",
                ],
            },
            {
                "title": "5.6. Parts inventory",
                "shots": [("mechanic-06-inventory.png", "Stock levels by part. Quantity on hand, qty reserved (for in-progress MWOs), reorder point.")],
                "paragraphs": [
                    "When stock hits the reorder point, admin gets a low-stock notification. Use the search box to find a part by name or SKU. Click any row to update the on-hand quantity (e.g. after receiving a delivery).",
                ],
            },
        ],
    },
    {
        "kind": "section",
        "title": "6. Tokenized driver links",
        "paragraphs": [
            "For one-off site visits where a driver shouldn't have a full account, admin can mint a tokenized link to a specific form. The driver opens the link in any browser, completes the form, and the token is automatically burned (one-time use).",
            "Generate via Settings → Driver tokens → Generate token. Pick the scope (which form) and validity window. Yardward returns a shareable URL that you SMS or email to the driver.",
            "When the driver opens the link, they land directly on the target form without a sign-in step. The token is scoped to that specific path — they can't access other parts of the app.",
        ],
    },
    {
        "kind": "section",
        "title": "7. Offline handling",
        "paragraphs": [
            "Drivers often work in dead zones (rural quarries, basement loading bays, etc.). Yardward handles offline submission gracefully:",
            "When a form is submitted without an internet connection, the data is stored in a local queue on the device. The PWA shows a small badge in the corner indicating pending submissions. When the device reconnects, the queue automatically flushes — submissions land in the database in the order they were created.",
            "Each submission carries an idempotency key, so even if a network blip causes a retry, the database refuses to insert duplicates. If a submission fails permanently (e.g. invalid data after server-side validation), it lands in the Dead-letter queue tab in admin's Error log for manual review.",
        ],
    },
    {
        "kind": "section",
        "title": "8. Notifications",
        "paragraphs": [
            "Yardward fires notifications for: new job assignments (SMS to driver), work orders awaiting approval (in-app + SMS to admin), tools flagged on checklist (in-app to admin + mechanic), GPS mismatch on time entry (in-app to admin), POs awaiting approval (in-app to admin), vehicle maintenance overdue (in-app to admin + mechanic), and Communications tags (in-app to tagged user).",
            "Configure org-wide defaults in Settings → Notifications. Drivers and mechanics can override per-user via /driver/profile → Notifications.",
        ],
    },
    {
        "kind": "section",
        "title": "9. Support",
        "paragraphs": [
            "For technical support, drivers/mechanics submit a ticket via /driver/profile → Help & support. Tickets land in admin's support_tickets queue.",
            "For account issues (forgot password, account locked, change of email), admin uses Settings → Users to manage or reset.",
            "For billing or contract questions, contact your Yardward account manager.",
        ],
    },
]


# ----- docx assembly ---------------------------------------------------------


def add_heading_styled(doc, text, level=1, color=None):
    h = doc.add_heading(text, level=level)
    for run in h.runs:
        if color:
            run.font.color.rgb = color
    return h


def add_para(doc, text, size=11, bold=False, color=None, italic=False):
    p = doc.add_paragraph()
    r = p.add_run(text)
    r.font.size = Pt(size)
    r.bold = bold
    r.italic = italic
    if color:
        r.font.color.rgb = color
    return p


def add_image(doc, name, caption):
    path = SHOTS / name
    if not path.exists():
        add_para(doc, f"[missing screenshot: {name}]", italic=True, color=MUTED)
        return
    # Constrain image width to 6.5 inches (fits standard 8.5x11 page with 1in margins)
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run()
    run.add_picture(str(path), width=Inches(6.0))
    # Caption beneath
    cap = doc.add_paragraph()
    cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
    cr = cap.add_run(f"Figure: {caption}")
    cr.italic = True
    cr.font.size = Pt(9)
    cr.font.color.rgb = MUTED


def render(content):
    doc = Document()
    # Set base font + margins
    for s in doc.styles:
        try:
            if s.name == "Normal":
                s.font.name = "Calibri"
                s.font.size = Pt(11)
        except Exception:
            pass
    for section in doc.sections:
        section.top_margin = Inches(0.8)
        section.bottom_margin = Inches(0.8)
        section.left_margin = Inches(1.0)
        section.right_margin = Inches(1.0)

    for node in content:
        if node["kind"] == "title":
            t = doc.add_paragraph()
            t.alignment = WD_ALIGN_PARAGRAPH.CENTER
            run = t.add_run(node["text"])
            run.font.size = Pt(36)
            run.font.bold = True
            run.font.color.rgb = NAVY
            sub = doc.add_paragraph()
            sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
            sr = sub.add_run(node["subtitle"])
            sr.font.size = Pt(14)
            sr.font.italic = True
            sr.font.color.rgb = MUTED
            # Spacer
            doc.add_paragraph()
            doc.add_paragraph()

        elif node["kind"] == "section":
            doc.add_page_break()
            add_heading_styled(doc, node["title"], level=1, color=AMBER)
            for p in node.get("paragraphs", []):
                add_para(doc, p)
            for shot in node.get("shots", []):
                add_image(doc, *shot)
            for sub in node.get("subsections", []):
                add_heading_styled(doc, sub["title"], level=2, color=NAVY)
                for p in sub.get("paragraphs", []):
                    add_para(doc, p)
                for shot in sub.get("shots", []):
                    add_image(doc, *shot)

    doc.save(OUT)
    print(f"Saved: {OUT}")


if __name__ == "__main__":
    render(CONTENT)
