// ============================================================================
// FlowControl — Notification Service
//
// In-app notifications are always created. Email delivery is attempted only
// when SMTP is configured via environment variables; when it is not, the
// attempt is HONESTLY recorded in EmailLog as SKIPPED_NO_SMTP. The
// application never claims an email was sent when it was not.
//
// Note on asynchronous delivery: in this deployment (no Celery/Redis), email
// logging and notification creation happen inline within the same request
// transaction. For scale, this service is the natural seam for introducing a
// background queue (documented in docs/ARCHITECTURE.md).
// ============================================================================

import { db } from '@/lib/db'
import type { Prisma } from '@prisma/client'
import type { RoleKey } from './rbac'

export type NotificationType = 'INFO' | 'ACTION_REQUIRED' | 'ALERT' | 'SYSTEM'

type DbClient = Prisma.TransactionClient | typeof db

export async function notify(
  client: DbClient,
  params: {
    userId: string
    type: NotificationType
    title: string
    body?: string | null
    link?: string | null
    email?: boolean
  },
): Promise<void> {
  await client.notification.create({
    data: {
      userId: params.userId,
      type: params.type,
      title: params.title,
      body: params.body ?? null,
      link: params.link ?? null,
    },
  })
  if (params.email) {
    await queueEmail(client, params.userId, params.title, params.body ?? '')
  }
}

/** Notify every active user holding the given role (e.g. escalation to directors). */
export async function notifyRole(
  client: DbClient,
  role: RoleKey,
  params: { type: NotificationType; title: string; body?: string; link?: string | null; email?: boolean },
): Promise<void> {
  const users = await client.user.findMany({ where: { role, isActive: true }, select: { id: true } })
  for (const u of users) {
    await notify(client, { ...params, userId: u.id })
  }
}

/**
 * Email delivery seam. When SMTP environment variables are absent, the attempt
 * is recorded as SKIPPED_NO_SMTP. When they are present but no transport has
 * been wired (see docs/LIMITATIONS.md), the log status is PENDING — the email
 * is queued for delivery but no actual send occurs until a transport
 * (e.g. nodemailer) is integrated at this seam.
 *
 * IMPORTANT: to enable real delivery, replace the PENDING branch below with
 * your transport call, then change status to 'SENT' on success or 'FAILED' on
 * error.
 */
async function queueEmail(
  client: DbClient,
  userId: string,
  subject: string,
  body: string,
): Promise<void> {
  const user = await client.user.findUnique({ where: { id: userId }, select: { email: true } })
  if (!user) return
  const smtpConfigured = Boolean(process.env.SMTP_HOST && process.env.SMTP_PORT)
  // ---- TRANSPORT SEAM -------------------------------------------------------
  // Replace this block with a real nodemailer/resend/etc. call when deploying
  // with SMTP. Until then, status = PENDING (not SENT) to avoid false records.
  // ---------------------------------------------------------------------------
  await client.emailLog.create({
    data: {
      toEmail: user.email,
      subject,
      status: smtpConfigured ? 'PENDING' : 'SKIPPED_NO_SMTP',
      detail: smtpConfigured
        ? 'SMTP variables are set but no transport is wired — integrate a mailer at src/server/notify.ts to enable delivery.'
        : 'SMTP is not configured in this environment — email not sent (recorded honestly, never faked).',
    },
  })
}
