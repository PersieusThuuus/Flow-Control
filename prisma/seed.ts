// ============================================================================
// FlowControl — Demo Data Seeder
//
// Builds a realistic, FICTIONAL dataset (Moroccan-enterprise flavored) by
// calling the SAME services the API uses (engine.submitDocument,
// engine.actOnInstance, documents.addDocumentVersion). Consequences:
//   - the audit hash chain is genuine and verifies cleanly,
//   - approvals reference exact document versions + SHA-256 hashes,
//   - workflow state is produced by the real engine (no fabricated state).
//
// Business timestamps are backdated (via the engine's `at` parameter, which
// is hash-bound into the audit chain) so dashboards show realistic cycle
// times, SLA states and one overdue escalation.
//
// All accounts share the documented demo password: FlowDemo#2024
// Run: bun run db:seed   (wipes existing data first)
// ============================================================================

import { rm, mkdir } from 'fs/promises'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import { db } from '../src/lib/db'
import { hashPassword } from '../src/server/auth'
import { recordAudit, verifyAuditChain } from '../src/server/audit'
import { addDocumentVersion, nextDocumentReference, STORAGE_DIR } from '../src/server/documents'
import { submitDocument, actOnInstance } from '../src/server/engine'
import { runControlMonitors } from '../src/server/monitors'
import type { SessionUser } from '../src/server/rbac'

const DEMO_PASSWORD = 'FlowDemo#2024'
const SEED_IP = '127.0.0.1'
const H = 3600_000 // one hour
const D = 24 * H // one day

const t = (base: Date, offsetMs: number): Date => new Date(base.getTime() - offsetMs)

/** Minimal, valid one-page PDF with Helvetica text (passes the %PDF- magic check). */
function makePdf(title: string, lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  const parts = [`BT /F1 16 Tf 50 780 Td (${esc(title)}) Tj ET`]
  lines.forEach((l, i) => parts.push(`BT /F1 10 Tf 50 ${744 - i * 18} Td (${esc(l)}) Tj ET`))
  const stream = parts.join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((o, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  offsets.forEach((off) => {
    pdf += `${String(off).padStart(10, '0')} 00000 n \n`
  })
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(pdf, 'latin1')
}

async function wipe(): Promise<void> {
  // Wipe in FK-safe order (test data from previous runs is disposable).
  await db.approval.deleteMany()
  await db.workflowInstance.deleteMany()
  await db.workflowStage.deleteMany()
  await db.workflow.deleteMany()
  await db.documentVersion.deleteMany()
  await db.document.deleteMany()
  await db.documentCategory.deleteMany()
  await db.controlException.deleteMany()
  await db.soDRule.deleteMany()
  await db.approvalRule.deleteMany()
  await db.approvalDelegation.deleteMany()
  await db.notification.deleteMany()
  await db.emailLog.deleteMany()
  await db.auditEvent.deleteMany()
  await db.loginAttempt.deleteMany()
  await db.session.deleteMany()
  await db.user.deleteMany()
  await db.department.deleteMany()
  // Clear the document vault.
  try {
    await rm(STORAGE_DIR, { recursive: true, force: true })
    await mkdir(STORAGE_DIR, { recursive: true })
  } catch {
    /* vault may not exist yet */
  }
}

type SeedUser = SessionUser & { passwordHash?: never }

async function main(): Promise<void> {
  const T0 = new Date()
  console.log('FlowControl demo data seeder')
  console.log('============================')

  await wipe()
  console.log('[1/8] Cleared existing data and document vault.')

  // ------------------------------------------------------------------ [2] Departments & users
  const deptDefs = [
    { code: 'PUR', name: 'Purchasing Department' },
    { code: 'FIN', name: 'Finance & Control' },
    { code: 'ACC', name: 'Accounting' },
    { code: 'TRES', name: 'Treasury' },
    { code: 'OPS', name: 'Operations' },
    { code: 'ITD', name: 'IT Department' },
    { code: 'HRD', name: 'Human Resources' },
    { code: 'AUD', name: 'Internal Audit' },
    { code: 'EXE', name: 'Executive Management' },
  ]
  const departments: Record<string, string> = {}
  for (const d of deptDefs) {
    const created = await db.department.create({ data: d })
    departments[d.code] = created.id
  }

  const userDefs: { email: string; name: string; role: SeedUser['role']; dept: string; jobTitle: string }[] = [
    { email: 'admin@flowcontrol.local', name: 'Sarah Bennani', role: 'SUPER_ADMIN', dept: 'EXE', jobTitle: 'System Administrator' },
    { email: 'purchasing@flowcontrol.local', name: 'Omar El Idrissi', role: 'PURCHASING', dept: 'PUR', jobTitle: 'Purchasing Officer' },
    { email: 'purchasing2@flowcontrol.local', name: 'Amine Chraibi', role: 'PURCHASING', dept: 'PUR', jobTitle: 'Junior Purchasing Officer' },
    { email: 'manager.pur@flowcontrol.local', name: 'Rachid Alami', role: 'DEPT_MANAGER', dept: 'PUR', jobTitle: 'Head of Purchasing' },
    { email: 'manager.ops@flowcontrol.local', name: 'Khadija Amrani', role: 'DEPT_MANAGER', dept: 'OPS', jobTitle: 'Operations Manager' },
    { email: 'controller@flowcontrol.local', name: 'Youssef Tazi', role: 'FIN_CONTROLLER', dept: 'FIN', jobTitle: 'Financial Controller' },
    { email: 'accountant@flowcontrol.local', name: 'Nadia Berrada', role: 'ACCOUNTANT', dept: 'ACC', jobTitle: 'Senior Accountant' },
    { email: 'treasury@flowcontrol.local', name: 'Hicham Ouazzani', role: 'TREASURY', dept: 'TRES', jobTitle: 'Treasury Officer' },
    { email: 'director@flowcontrol.local', name: 'Leila Fassi', role: 'GENERAL_DIRECTOR', dept: 'EXE', jobTitle: 'General Director' },
    { email: 'auditor@flowcontrol.local', name: 'Karim Naciri', role: 'INTERNAL_AUDITOR', dept: 'AUD', jobTitle: 'Internal Auditor' },
  ]
  const users: Record<string, SeedUser> = {}
  for (const u of userDefs) {
    const created = await db.user.create({
      data: {
        email: u.email,
        name: u.name,
        passwordHash: hashPassword(DEMO_PASSWORD),
        role: u.role,
        jobTitle: u.jobTitle,
        departmentId: departments[u.dept],
      },
    })
    users[u.email] = {
      id: created.id,
      email: u.email,
      name: u.name,
      role: u.role,
      jobTitle: u.jobTitle,
      departmentId: departments[u.dept],
      departmentName: deptDefs.find((d) => d.code === u.dept)?.name ?? null,
      departmentCode: u.dept,
    }
  }
  const admin = users['admin@flowcontrol.local']
  const purchasing = users['purchasing@flowcontrol.local']
  const purchasing2 = users['purchasing2@flowcontrol.local']
  const managerPur = users['manager.pur@flowcontrol.local']
  const controller = users['controller@flowcontrol.local']
  const accountant = users['accountant@flowcontrol.local']
  const treasury = users['treasury@flowcontrol.local']
  const director = users['director@flowcontrol.local']

  for (const u of userDefs) {
    await recordAudit(db, {
      at: t(T0, 30 * D),
      actor: { id: admin.id, role: admin.role },
      action: 'USER_CREATED',
      entityType: 'user',
      entityId: users[u.email].id,
      details: { email: u.email, name: u.name, role: u.role },
      ip: SEED_IP,
    })
  }
  console.log(`[2/8] Created ${deptDefs.length} departments and ${userDefs.length} users.`)

  // ------------------------------------------------------------------ [3] Categories
  const catDefs = [
    { code: 'PURCHASE_ORDER', name: 'Purchase Order', description: 'Commitment to a supplier for goods or services', requiredEvidence: ['Supplier quotation', 'Budget line reference', 'Purchase requisition approval'] },
    { code: 'PURCHASE_REQUISITION', name: 'Purchase Requisition', description: 'Internal request to purchase goods or services', requiredEvidence: ['Justification memo'] },
    { code: 'SUPPLIER_INVOICE', name: 'Supplier Invoice', description: 'Invoice received from a supplier awaiting payment authorization', requiredEvidence: ['Original invoice', 'Delivery note', 'Purchase order reference'] },
    { code: 'EXPENSE_REPORT', name: 'Expense Report', description: 'Employee expense reimbursement request', requiredEvidence: ['Itemized receipts'] },
    { code: 'CONTRACT', name: 'Contract', description: 'Contract or framework agreement requiring signature', requiredEvidence: ['Legal review note', 'Counterparty KYC file'] },
    { code: 'BUDGET_AUTH', name: 'Budget Authorization', description: 'Budget envelope or budget revision authorization', requiredEvidence: ['Budget worksheet'] },
    { code: 'PAYMENT_AUTH', name: 'Payment Authorization', description: 'Outgoing payment authorization', requiredEvidence: ['Invoice', 'Bank details confirmation'] },
    { code: 'ADMIN_REQUEST', name: 'Administrative Request', description: 'General internal administrative request', requiredEvidence: [] },
  ]
  const categories: Record<string, string> = {}
  for (const c of catDefs) {
    const created = await db.documentCategory.create({
      data: { code: c.code, name: c.name, description: c.description, requiredEvidence: JSON.stringify(c.requiredEvidence) },
    })
    categories[c.code] = created.id
  }
  console.log('[3/8] Created document categories.')

  // ------------------------------------------------------------------ [4] Workflows
  async function stage(data: {
    sequence: number
    name: string
    approverRole: string
    departmentScope?: string
    departmentId?: string | null
    minAmount?: bigint | null
    maxAmount?: bigint | null
    isRequired?: boolean
    slaHours?: number | null
  }) {
    return {
      sequence: data.sequence,
      name: data.name,
      approverRole: data.approverRole,
      departmentScope: data.departmentScope ?? 'ANY',
      departmentId: data.departmentId ?? null,
      minAmount: data.minAmount ?? null,
      maxAmount: data.maxAmount ?? null,
      isRequired: data.isRequired ?? true,
      slaHours: data.slaHours ?? null,
    }
  }

  // Standard purchase approval: sequential chain, amount-conditional stages.
  const wfPurchase = await db.workflow.create({
    data: {
      code: 'WF-PUR-STD',
      name: 'Standard Purchase Approval',
      description: 'Purchase orders: department manager, financial control, accounting, and (above 100,000) General Director + Treasury.',
      categoryId: categories.PURCHASE_ORDER,
      isActive: true,
      stages: {
        create: [
          await stage({ sequence: 10, name: 'Department Manager Review', approverRole: 'DEPT_MANAGER', departmentScope: 'DOCUMENT', slaHours: 48 }),
          await stage({ sequence: 20, name: 'Financial Control — Budget Verification', approverRole: 'FIN_CONTROLLER', departmentScope: 'FIXED', departmentId: departments.FIN, minAmount: 10000n, slaHours: 72 }),
          await stage({ sequence: 30, name: 'Accounting Review', approverRole: 'ACCOUNTANT', departmentScope: 'FIXED', departmentId: departments.ACC, minAmount: 10000n, slaHours: 48 }),
          await stage({ sequence: 40, name: 'General Director Authorization', approverRole: 'GENERAL_DIRECTOR', departmentScope: 'FIXED', departmentId: departments.EXE, minAmount: 100000n, slaHours: 96 }),
          await stage({ sequence: 50, name: 'Treasury Payment Preparation', approverRole: 'TREASURY', departmentScope: 'FIXED', departmentId: departments.TRES, minAmount: 100000n, slaHours: 120 }),
        ],
      },
    },
  })

  // Expense reports: lighter chain.
  await db.workflow.create({
    data: {
      code: 'WF-EXP-STD',
      name: 'Expense Report Approval',
      description: 'Expense reports: department manager, financial control above 5,000, then treasury reimbursement.',
      categoryId: categories.EXPENSE_REPORT,
      isActive: true,
      stages: {
        create: [
          await stage({ sequence: 10, name: 'Department Manager Review', approverRole: 'DEPT_MANAGER', departmentScope: 'DOCUMENT', slaHours: 48 }),
          await stage({ sequence: 20, name: 'Financial Control Review', approverRole: 'FIN_CONTROLLER', departmentScope: 'FIXED', departmentId: departments.FIN, minAmount: 5000n, slaHours: 72 }),
          await stage({ sequence: 30, name: 'Treasury Reimbursement', approverRole: 'TREASURY', departmentScope: 'FIXED', departmentId: departments.TRES, slaHours: 120 }),
        ],
      },
    },
  })

  // Contracts: PARALLEL financial review (controller + accountant in one step).
  const wfContract = await db.workflow.create({
    data: {
      code: 'WF-CON-STD',
      name: 'Contract Approval',
      description: 'Contracts: department manager, PARALLEL financial control + accounting review, General Director above 200,000.',
      categoryId: categories.CONTRACT,
      isActive: true,
      stages: {
        create: [
          await stage({ sequence: 10, name: 'Department Manager Review', approverRole: 'DEPT_MANAGER', departmentScope: 'DOCUMENT', slaHours: 48 }),
          await stage({ sequence: 20, name: 'Financial Control Review', approverRole: 'FIN_CONTROLLER', departmentScope: 'FIXED', departmentId: departments.FIN, slaHours: 72 }),
          await stage({ sequence: 20, name: 'Accounting & Compliance Review', approverRole: 'ACCOUNTANT', departmentScope: 'FIXED', departmentId: departments.ACC, slaHours: 72 }),
          await stage({ sequence: 30, name: 'General Director Authorization', approverRole: 'GENERAL_DIRECTOR', departmentScope: 'FIXED', departmentId: departments.EXE, minAmount: 200000n, slaHours: 96 }),
        ],
      },
    },
  })

  // Supplier invoices.
  await db.workflow.create({
    data: {
      code: 'WF-INV-STD',
      name: 'Supplier Invoice Approval',
      description: 'Supplier invoices: department manager, financial control above 5,000, accounting, treasury above 50,000.',
      categoryId: categories.SUPPLIER_INVOICE,
      isActive: true,
      stages: {
        create: [
          await stage({ sequence: 10, name: 'Department Manager Review', approverRole: 'DEPT_MANAGER', departmentScope: 'DOCUMENT', slaHours: 48 }),
          await stage({ sequence: 20, name: 'Financial Control Review', approverRole: 'FIN_CONTROLLER', departmentScope: 'FIXED', departmentId: departments.FIN, minAmount: 5000n, slaHours: 72 }),
          await stage({ sequence: 30, name: 'Accounting Review', approverRole: 'ACCOUNTANT', departmentScope: 'FIXED', departmentId: departments.ACC, slaHours: 48 }),
          await stage({ sequence: 40, name: 'Treasury Payment Execution', approverRole: 'TREASURY', departmentScope: 'FIXED', departmentId: departments.TRES, minAmount: 50000n, slaHours: 120 }),
        ],
      },
    },
  })

  for (const wf of await db.workflow.findMany()) {
    await recordAudit(db, {
      at: t(T0, 29 * D),
      actor: { id: admin.id, role: admin.role },
      action: 'WORKFLOW_CONFIG_CHANGED',
      entityType: 'workflow',
      entityId: wf.id,
      details: { code: wf.code, name: wf.name, created: true },
      ip: SEED_IP,
    })
  }
  console.log('[4/8] Created 4 configurable workflows (incl. a parallel-step contract workflow).')

  // ------------------------------------------------------------------ [5] Control configuration
  const thresholds: { role: string; maxAmount: bigint | null }[] = [
    { role: 'PURCHASING', maxAmount: 0n },
    { role: 'DEPT_MANAGER', maxAmount: 50000n },
    { role: 'FIN_CONTROLLER', maxAmount: 500000n },
    { role: 'ACCOUNTANT', maxAmount: 200000n },
    { role: 'TREASURY', maxAmount: null },
    { role: 'GENERAL_DIRECTOR', maxAmount: null },
  ]
  for (const th of thresholds) {
    await db.approvalRule.create({ data: { role: th.role, maxAmount: th.maxAmount } })
  }
  await recordAudit(db, {
    at: t(T0, 29 * D),
    actor: { id: admin.id, role: admin.role },
    action: 'THRESHOLD_CONFIG_CHANGED',
    entityType: 'system',
    details: { rules: thresholds.map((x) => ({ role: x.role, maxAmount: x.maxAmount?.toString() ?? 'unlimited' })) },
    ip: SEED_IP,
  })

  const sodRules = [
    { code: 'SOD-SELF', name: 'Self-approval prevention', ruleType: 'SELF_APPROVAL', roleA: null, roleB: null, severity: 'CRITICAL', description: 'A user can never approve a request they created themselves. Enforced as a hard block.' },
    { code: 'SOD-MULTI-STAGE', name: 'Multi-stage separation', ruleType: 'MULTI_STAGE_SAME_USER', roleA: null, roleB: null, severity: 'HIGH', description: 'The same user may not approve two different steps of the same request. Enforced as a hard block.' },
    { code: 'SOD-PUR-TRES', name: 'Purchasing / Treasury incompatibility', ruleType: 'ROLE_PAIR', roleA: 'PURCHASING', roleB: 'TREASURY', severity: 'MEDIUM', description: 'Purchasing and treasury duties may not both approve the same transaction.' },
  ]
  for (const r of sodRules) {
    await db.soDRule.create({ data: r })
    await recordAudit(db, {
      at: t(T0, 29 * D),
      actor: { id: admin.id, role: admin.role },
      action: 'SOD_RULE_CHANGED',
      entityType: 'sod_rule',
      details: { code: r.code, ruleType: r.ruleType, created: true },
      ip: SEED_IP,
    })
  }
  console.log('[5/8] Configured approval thresholds and segregation-of-duties rules.')

  // ------------------------------------------------------------------ [6] Documents
  async function createDocument(opts: {
    title: string
    categoryCode: string
    amount: bigint
    supplier?: string
    creator: SeedUser
    evidence: string[]
    justification?: string
    description?: string
    pdfTitle?: string
    pdfLines: string[]
    createdAt: Date
  }): Promise<string> {
    const buffer = makePdf(opts.pdfTitle ?? opts.title, opts.pdfLines)
    const sha256 = createHash('sha256').update(buffer).digest('hex')
    const documentId = await db.$transaction(async (tx) => {
      const reference = await nextDocumentReference(tx)
      const doc = await tx.document.create({
        data: {
          reference,
          title: opts.title,
          description: opts.description ?? null,
          categoryId: categories[opts.categoryCode],
          departmentId: departments[opts.creator.departmentCode ?? 'PUR'],
          createdById: opts.creator.id,
          supplierName: opts.supplier ?? null,
          amount: opts.amount,
          evidenceProvided: JSON.stringify(opts.evidence),
          evidenceJustification: opts.justification ?? null,
          status: 'DRAFT',
        },
      })
      await mkdir(STORAGE_DIR, { recursive: true })
      const { writeFile } = await import('fs/promises')
      await writeFile(path.join(STORAGE_DIR, `${randomUUID()}.pdf`), buffer)
      // Reuse the service version-appender for consistent rows:
      await addDocumentVersion(tx, {
        documentId: doc.id,
        buffer,
        originalName: `${reference}.pdf`,
        ext: '.pdf',
        mimeType: 'application/pdf',
        sha256,
        sizeBytes: buffer.length,
        uploadedById: opts.creator.id,
        note: 'Initial version',
      })
      await recordAudit(tx, {
        at: opts.createdAt,
        actor: { id: opts.creator.id, role: opts.creator.role },
        action: 'DOCUMENT_CREATED',
        entityType: 'document',
        entityId: doc.id,
        details: { reference, title: opts.title, amount: opts.amount.toString(), sha256 },
        ip: SEED_IP,
      })
      return doc.id
    })
    return documentId
  }

  async function submit(docId: string, creator: SeedUser, at: Date): Promise<string> {
    const result = await submitDocument({ user: creator, documentId: docId, ip: SEED_IP, at })
    if (!result.ok) throw new Error(`Submit failed for ${docId}: ${result.message}`)
    return result.instanceId
  }

  async function act(user: SeedUser, instanceId: string, action: 'APPROVE' | 'REJECT' | 'RETURN_FOR_CORRECTION', at: Date, comment?: string, stageId?: string): Promise<void> {
    const result = await actOnInstance({ user, instanceId, action, comment: comment ?? null, confirm: true, stageId: stageId ?? null, ip: SEED_IP, at })
    if (!result.ok) throw new Error(`Action ${action} failed: ${result.message}`)
  }

  // DOC 1 — PO 150,000: the guided-walkthrough document, currently at Accounting Review.
  const d1 = await createDocument({
    title: 'Office IT equipment — batch purchase (Q3)',
    categoryCode: 'PURCHASE_ORDER',
    amount: 150000n,
    supplier: 'Atlas Technologies SARL',
    creator: purchasing,
    evidence: ['Supplier quotation', 'Budget line reference', 'Purchase requisition approval'],
    description: '24 workstations, 2 docking stations and peripherals per the Q3 refresh plan.',
    pdfLines: ['Purchase Order — Office IT equipment (Q3 refresh)', 'Supplier: Atlas Technologies SARL', 'Total: 150,000 MAD', 'Delivery: 15 days after order confirmation', 'Payment terms: 30 days net'],
    createdAt: t(T0, 3 * D),
  })
  const i1 = await submit(d1, purchasing, t(T0, 3 * D))
  await act(managerPur, i1, 'APPROVE', t(T0, 2 * D + 20 * H), 'Within the Q3 IT budget envelope.')
  await act(controller, i1, 'APPROVE', t(T0, 1 * D + 4 * H), 'Budget line IT-2025-03 has sufficient coverage.')

  // DOC 2 — Contract 350,000: PARALLEL step pending (controller + accountant).
  const d2 = await createDocument({
    title: 'Facility maintenance services — annual contract',
    categoryCode: 'CONTRACT',
    amount: 350000n,
    supplier: 'Medina Facility Services',
    creator: purchasing,
    evidence: ['Legal review note', 'Counterparty KYC file'],
    description: 'Annual maintenance contract for the Casablanca HQ (HVAC, electrical, safety).',
    pdfLines: ['Contract — Facility maintenance services', 'Counterparty: Medina Facility Services', 'Annual value: 350,000 MAD', 'Term: 12 months, renewable once'],
    createdAt: t(T0, 2 * D),
  })
  const i2 = await submit(d2, purchasing, t(T0, 2 * D))
  await act(managerPur, i2, 'APPROVE', t(T0, 1 * D + 6 * H))

  // DOC 3 — PO 12,500: fully APPROVED (3-stage chain, realistic dwell times).
  const d3 = await createDocument({
    title: 'Office supplies — Q3 restocking',
    categoryCode: 'PURCHASE_ORDER',
    amount: 12500n,
    supplier: 'Papeterie Centrale',
    creator: purchasing,
    evidence: ['Supplier quotation', 'Budget line reference', 'Purchase requisition approval'],
    pdfLines: ['Purchase Order — Office supplies restocking', 'Supplier: Papeterie Centrale', 'Total: 12,500 MAD'],
    createdAt: t(T0, 9 * D),
  })
  const i3 = await submit(d3, purchasing, t(T0, 9 * D))
  await act(managerPur, i3, 'APPROVE', t(T0, 8 * D + 3 * H))
  await act(controller, i3, 'APPROVE', t(T0, 6 * D + 7 * H), 'Minor amount — within office supplies budget.')
  await act(accountant, i3, 'APPROVE', t(T0, 4 * D + 2 * H), 'Supporting documents complete.')

  // DOC 4 — Contract 220,000: at General Director, OVERDUE (step started 7 days ago, SLA 96h).
  const d4 = await createDocument({
    title: 'ERP consulting engagement',
    categoryCode: 'CONTRACT',
    amount: 220000n,
    supplier: 'Atlas Consulting',
    creator: purchasing,
    evidence: ['Legal review note', 'Counterparty KYC file'],
    description: 'Implementation support for the ERP rollout (phase 2).',
    pdfLines: ['Contract — ERP consulting engagement (phase 2)', 'Counterparty: Atlas Consulting', 'Value: 220,000 MAD'],
    createdAt: t(T0, 12 * D),
  })
  const i4 = await submit(d4, purchasing, t(T0, 12 * D))
  await act(managerPur, i4, 'APPROVE', t(T0, 11 * D + 5 * H))
  await act(controller, i4, 'APPROVE', t(T0, 9 * D + 8 * H), 'Phase 2 is included in the approved investment plan.')
  await act(accountant, i4, 'APPROVE', t(T0, 7 * D))

  // DOC 5 — Expense 8,200 by the second purchasing officer: REJECTED by financial control.
  const d5 = await createDocument({
    title: 'Client visit expenses — Rabat (March)',
    categoryCode: 'EXPENSE_REPORT',
    amount: 8200n,
    creator: purchasing2,
    evidence: ['Itemized receipts'],
    description: 'Two-day client visit: travel, hotel, dinner with client.',
    pdfLines: ['Expense report — Client visit Rabat', 'Claimant: Amine Chraibi', 'Total: 8,200 MAD'],
    createdAt: t(T0, 5 * D),
  })
  const i5 = await submit(d5, purchasing2, t(T0, 5 * D))
  await act(managerPur, i5, 'APPROVE', t(T0, 4 * D + 9 * H))
  await act(controller, i5, 'REJECT', t(T0, 3 * D + 2 * H), 'Dinner receipt is not itemized and exceeds the hospitality policy ceiling. Please resubmit with a compliant receipt.')

  // DOC 6 — PO 4,800: DRAFT with MISSING mandatory evidence (no justification) — demonstrates the control.
  await createDocument({
    title: 'Warehouse racking upgrade',
    categoryCode: 'PURCHASE_ORDER',
    amount: 4800n,
    supplier: 'StockPro Equipment',
    creator: purchasing,
    evidence: ['Supplier quotation'],
    description: 'Additional racking for the Casablanca warehouse.',
    pdfLines: ['Purchase Order — Warehouse racking upgrade', 'Supplier: StockPro Equipment', 'Total: 4,800 MAD'],
    createdAt: t(T0, 6 * H),
  })

  // DOC 7 — PO 9,999: RETURNED for correction by the manager.
  const d7 = await createDocument({
    title: 'Marketing print materials',
    categoryCode: 'PURCHASE_ORDER',
    amount: 9999n,
    supplier: 'Imprimerie Atlas',
    creator: purchasing,
    evidence: ['Supplier quotation', 'Budget line reference', 'Purchase requisition approval'],
    pdfLines: ['Purchase Order — Marketing print materials', 'Supplier: Imprimerie Atlas', 'Total: 9,999 MAD'],
    createdAt: t(T0, 2 * D + 4 * H),
  })
  const i7 = await submit(d7, purchasing, t(T0, 2 * D + 4 * H))
  await act(managerPur, i7, 'RETURN_FOR_CORRECTION', t(T0, 1 * D + 2 * H), 'The quotation exceeds the market reference by ~15%. Please renegotiate or provide a comparative analysis.')

  // DOC 8 — PO 120,000: fully APPROVED through all 5 stages including Director + Treasury.
  const d8 = await createDocument({
    title: 'Payment authorization — ERP license renewal',
    categoryCode: 'PURCHASE_ORDER',
    amount: 120000n,
    supplier: 'Atlas Technologies SARL',
    creator: purchasing,
    evidence: ['Supplier quotation', 'Budget line reference', 'Purchase requisition approval'],
    description: 'Annual ERP license renewal for 120 seats.',
    pdfLines: ['Purchase Order — ERP license renewal', 'Supplier: Atlas Technologies SARL', 'Total: 120,000 MAD', 'Renewal term: 12 months'],
    createdAt: t(T0, 20 * D),
  })
  const i8 = await submit(d8, purchasing, t(T0, 20 * D))
  await act(managerPur, i8, 'APPROVE', t(T0, 19 * D + 3 * H))
  await act(controller, i8, 'APPROVE', t(T0, 16 * D + 6 * H))
  await act(accountant, i8, 'APPROVE', t(T0, 14 * D + 1 * H))
  await act(director, i8, 'APPROVE', t(T0, 11 * D + 5 * H), 'Approved — renewals are strategic commitments.')
  await act(treasury, i8, 'APPROVE', t(T0, 9 * D + 8 * H), 'Payment scheduled for the 30th.')

  console.log('[6/8] Created 8 documents with realistic workflow histories (approved / in-progress / overdue / rejected / returned / draft).')

  // ------------------------------------------------------------------ [7] Failed logins (audit demo data)
  const failedLogins: { email: string; reason: string; at: Date }[] = [
    { email: 'purchasing@flowcontrol.local', reason: 'INVALID_CREDENTIALS', at: t(T0, 2 * D) },
    { email: 'unknown@external.example', reason: 'INVALID_CREDENTIALS', at: t(T0, 1 * D + 8 * H) },
    { email: 'auditor@flowcontrol.local', reason: 'INVALID_CREDENTIALS', at: t(T0, 10 * H) },
  ]
  for (const f of failedLogins) {
    await db.loginAttempt.create({
      data: { email: f.email, success: false, reason: f.reason, ip: '10.20.30.40', createdAt: f.at },
    })
    await recordAudit(db, {
      at: f.at,
      actor: null,
      action: 'LOGIN_FAILED',
      entityType: 'user',
      entityId: f.email,
      details: { email: f.email, reason: f.reason },
      ip: '10.20.30.40',
    })
  }

  // A few successful logins for realistic lastLoginAt values.
  for (const email of ['admin@flowcontrol.local', 'purchasing@flowcontrol.local', 'controller@flowcontrol.local']) {
    const u = await db.user.findUnique({ where: { email } })
    if (u) {
      await db.user.update({ where: { id: u.id }, data: { lastLoginAt: t(T0, 4 * H) } })
      await recordAudit(db, {
        at: t(T0, 4 * H),
        actor: { id: u.id, role: u.role },
        action: 'LOGIN_SUCCESS',
        entityType: 'user',
        entityId: u.id,
        details: { email },
        ip: SEED_IP,
      })
    }
  }
  console.log('[7/8] Recorded login history (3 failed attempts, 3 successful logins).')

  // ------------------------------------------------------------------ [8] Run control monitors + verify chain
  const monitorSummary = await runControlMonitors(admin, SEED_IP)
  const verification = await verifyAuditChain()
  if (!verification.valid) {
    throw new Error(`Audit chain INVALID after seeding: ${JSON.stringify(verification.issues.slice(0, 3))}`)
  }

  console.log('[8/8] Control monitors executed and audit chain verified.')
  console.log('')
  console.log('  Monitor summary:', JSON.stringify(monitorSummary))
  console.log(`  Audit chain: VALID — ${verification.eventCount} events, anchor ${verification.latestHash?.slice(0, 16)}…`)
  console.log('')
  console.log('  Demo accounts (password: FlowDemo#2024)')
  console.log('  ---------------------------------------')
  for (const u of userDefs) {
    console.log(`  ${u.email.padEnd(34)} ${u.role.padEnd(18)} ${u.name}`)
  }
  console.log('')
  console.log('  Walkthrough suggestion:')
  console.log('  1. Login as accountant@flowcontrol.local — pending approval for DOC 150,000 (IT equipment).')
  console.log('  2. Login as director@flowcontrol.local — see the escalated OVERDUE contract.')
  console.log('  3. Login as auditor@flowcontrol.local — Internal Audit dashboard, exceptions, chain integrity.')
  console.log('  4. Login as admin@flowcontrol.local — full administration console.')
}

main()
  .catch((err) => {
    console.error('Seeding failed:', err)
    process.exit(1)
  })
  .finally(() => {
    void db.$disconnect()
  })
