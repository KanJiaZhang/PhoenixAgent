/**
 * M0: the warehouse adapter. A catalog you can read, a runner you can only read through, and the document
 * readers whose output is evidence rather than truth.
 */

export { readSqliteCatalog, sqliteRunner, quote } from './sqlite.ts';
export type { Catalog, ColumnMeta, TableMeta, QueryResult, QueryRunner } from './sqlite.ts';
export { assertReadOnly, ReadOnlyViolation } from './guard.ts';
export type { GuardResult } from './guard.ts';
export { extractDocMentions, contributionDrivers } from './docs.ts';
export { profileCatalog, profileTable } from './profile.ts';
export type { ColumnProfile, TableProfile, ProfileOptions } from './profile.ts';
export { extractPdfText } from './pdf.ts';
export type { PdfExtraction, PdfPage } from './pdf.ts';
export type { DocMention, MentionKind, UnsupportedDocument } from './docs.ts';
