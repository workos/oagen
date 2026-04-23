/**
 * Approval matching engine for compatibility verification.
 *
 * Matches CompatApproval entries from oagen.config.ts against classified
 * changes. Approved changes are excluded from failure thresholds.
 *
 * Approvals must be narrow (one symbol, one category, one conceptual change).
 * Overly broad approvals are rejected at validation time.
 */

import type { LanguageId } from './ir.js';
import type { CompatApproval } from './config.js';
import type { ClassifiedChange } from './classify.js';

/** Result of matching a change against approvals. */
export interface ApprovalMatch {
  /** The change that was matched. */
  change: ClassifiedChange;
  /** The approval that matched. null if no approval covers this change. */
  approval: CompatApproval | null;
  /** Whether the change is covered by an approval. */
  approved: boolean;
}

/** Result of validating an approval for broadness. */
export interface ApprovalValidation {
  valid: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validate that an approval is narrow enough to be accepted. */
export function validateApproval(approval: CompatApproval): ApprovalValidation {
  const errors: string[] = [];

  if (!approval.symbol || approval.symbol.trim() === '') {
    errors.push('Approval must target a specific symbol');
  }

  if (!approval.category) {
    errors.push('Approval must specify a change category');
  }

  if (!approval.reason || approval.reason.trim() === '') {
    errors.push('Approval must include a reason');
  }

  // Wildcard symbols are too broad
  if (approval.symbol === '*' || approval.symbol.endsWith('.*') || approval.symbol.endsWith('::*')) {
    errors.push(`Approval symbol "${approval.symbol}" is too broad — must target a specific symbol`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/** Validate all approvals in a config. Returns errors keyed by index. */
export function validateApprovals(approvals: CompatApproval[]): Map<number, string[]> {
  const result = new Map<number, string[]>();
  for (let i = 0; i < approvals.length; i++) {
    const validation = validateApproval(approvals[i]);
    if (!validation.valid) {
      result.set(i, validation.errors);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Match a classified change against a list of approvals.
 * Returns the first matching approval, or null if none match.
 */
export function matchApproval(
  change: ClassifiedChange,
  approvals: CompatApproval[],
  language: LanguageId,
): CompatApproval | null {
  for (const approval of approvals) {
    if (approvalMatchesChange(approval, change, language)) {
      return approval;
    }
  }
  return null;
}

/**
 * Apply approvals to a list of changes.
 * Returns matches for every change (approved or not).
 */
export function applyApprovals(
  changes: ClassifiedChange[],
  approvals: CompatApproval[],
  language: LanguageId,
): ApprovalMatch[] {
  return changes.map((change) => {
    const approval = matchApproval(change, approvals, language);
    return {
      change,
      approval,
      approved: approval !== null,
    };
  });
}

/**
 * Filter changes to only those NOT covered by approvals.
 * These are the remaining unapproved changes that may cause failure.
 */
export function unapprovedChanges(
  changes: ClassifiedChange[],
  approvals: CompatApproval[],
  language: LanguageId,
): ClassifiedChange[] {
  return changes.filter((change) => !matchApproval(change, approvals, language));
}

// ---------------------------------------------------------------------------
// Internal matching logic
// ---------------------------------------------------------------------------

function approvalMatchesChange(approval: CompatApproval, change: ClassifiedChange, language: LanguageId): boolean {
  // Skip inactive approvals
  if (approval.approved === false) return false;

  // Category must match exactly
  if (approval.category !== change.category) return false;

  // Symbol must match
  if (!symbolMatches(approval.symbol, change.symbol)) return false;

  // Language scoping
  if (!languageMatches(approval.appliesTo, language)) return false;

  // Narrowing match (optional)
  if (approval.match && !narrowingMatches(approval.match, change)) return false;

  return true;
}

function symbolMatches(approvalSymbol: string, changeSymbol: string): boolean {
  // Exact match
  if (approvalSymbol === changeSymbol) return true;

  // Normalize common separators for cross-language matching
  // PHP uses :: and \, others use . — normalize to dots for comparison
  const normalizedApproval = approvalSymbol.replace(/::/g, '.').replace(/\\/g, '.');
  const normalizedChange = changeSymbol.replace(/::/g, '.').replace(/\\/g, '.');
  return normalizedApproval === normalizedChange;
}

function languageMatches(appliesTo: CompatApproval['appliesTo'], language: LanguageId): boolean {
  if (!appliesTo || appliesTo === 'all-impacted-languages') return true;
  return appliesTo.includes(language);
}

function narrowingMatches(match: NonNullable<CompatApproval['match']>, change: ClassifiedChange): boolean {
  if (match.parameter) {
    // Check if the change involves this parameter
    const paramInOld = change.old.parameter === match.parameter;
    const paramInNew = change.new.parameter === match.parameter;
    if (!paramInOld && !paramInNew) return false;
  }
  if (match.member) {
    const memberInOld = change.old.member === match.member;
    const memberInNew = change.new.member === match.member;
    if (!memberInOld && !memberInNew) return false;
  }
  if (match.oldName) {
    const nameMatch = Object.values(change.old).some((v) => v === match.oldName);
    if (!nameMatch) return false;
  }
  if (match.newName) {
    const nameMatch = Object.values(change.new).some((v) => v === match.newName);
    if (!nameMatch) return false;
  }
  return true;
}
