/**
 * pt-BR labels for the case enums (05 §1, §3 "Legibilidade": English enums on
 * the wire, Portuguese on screen). These maps are the only place the UI spells
 * a status, a preset, an item or annotation kind, a decision or a hypothesis state.
 */
import type {
  AnnotationKind,
  DecisionAction,
  DecisionOutcome,
  HypothesisStatus,
  Investigation,
  InvestigationStatus,
  ItemKind,
  KindPreset,
  WriteStatus,
} from '@/types/investigation';

export const STATUS_LABELS: Record<InvestigationStatus, string> = {
  open: 'Aberto',
  analysis: 'Em análise',
  decided: 'Decidido',
  archived: 'Arquivado',
};

/** Status changes a person makes through PATCH (05 §3); the server answers 409 to any other. */
export const STATUS_TRANSITIONS: Record<InvestigationStatus, Exclude<InvestigationStatus, 'decided'>[]> = {
  open: ['analysis', 'archived'],
  analysis: ['open', 'archived'],
  decided: ['archived'],
  archived: ['analysis'],
};

export const KIND_PRESET_LABELS: Record<KindPreset, string> = {
  livre: 'Livre',
  credito: 'Crédito (grupo econômico)',
  garantia: 'Fuga de garantia',
  pix_med: 'Pix com MED',
  lavagem: 'Lavagem de dinheiro',
  lojista: 'Revisão de lojista',
  fraude_sintetica: 'Fraude sintética',
};

export const DECISION_OUTCOME_LABELS: Record<DecisionOutcome, string> = {
  comunicar: 'Comunicar ao COAF via Siscoaf',
  arquivar: 'Arquivar com fundamentação',
  medida: 'Medida cautelar (bloqueio, retenção)',
  parecer: 'Apenas parecer (sem comunicação)',
};

export const DECISION_ACTION_LABELS: Record<DecisionAction, string> = {
  dict: 'Marcar as contas no DICT',
  spa: 'Notificar o SPA (24 h)',
  bloqueio_cautelar: 'Pedir bloqueio cautelar',
};

export const HYPOTHESIS_STATUS_LABELS: Record<HypothesisStatus, string> = {
  open: 'aberta',
  supported: 'sustentada',
  refuted: 'refutada',
};

export const ITEM_KIND_LABELS: Record<ItemKind, string> = {
  graph: 'Grafo',
  query: 'Consulta',
  table: 'Tabela',
  document: 'Documento',
  note: 'Nota',
};

/** Plural headings of the material list. */
export const ITEM_KIND_PLURALS: Record<ItemKind, string> = {
  graph: 'Grafos',
  query: 'Consultas',
  table: 'Tabelas',
  document: 'Documentos',
  note: 'Notas',
};

export const ANNOTATION_KIND_LABELS: Record<AnnotationKind, string> = {
  role: 'papel',
  tag: 'tag',
  group: 'grupo',
  same_as: 'mesmo que',
  hypothesis: 'hipótese',
  hypothesis_status: 'estado da hipótese',
  typology: 'tipologia',
  status_change: 'mudança de status',
};

export const WRITE_STATUS_LABELS: Record<WriteStatus, string> = {
  suggested: 'sugerido',
  confirmed: 'confirmado',
  rejected: 'recusado',
};

/** Deadline phases (05 §7): selection while the case is open, analysis afterwards. */
export const PHASE_LABELS: Record<'open' | 'analysis', string> = {
  open: 'seleção',
  analysis: 'análise',
};

export const AUTHOR_KIND_LABELS = { human: 'pessoa', agent: 'agente' } as const;

export const itemKindLabel = (kind: string) => ITEM_KIND_LABELS[kind as ItemKind] ?? kind;
export const annotationKindLabel = (kind: string) => ANNOTATION_KIND_LABELS[kind as AnnotationKind] ?? kind;
export const statusLabel = (status: string) => STATUS_LABELS[status as InvestigationStatus] ?? status;
export const presetLabel = (preset: string) => KIND_PRESET_LABELS[preset as KindPreset] ?? preset;

/** Under this many days left the deadline turns orange (T1). */
export const URGENT_DAYS = 7;

/** `#0412`-style short id for titles and journal lines (never a raw UUID). */
export function caseNumber(id: string): string {
  return `#${id.replace(/-/g, '').slice(0, 6)}`;
}

/** "Golpe Pix · #0412aa": how a case is named anywhere outside its own header. */
export function caseTitle(inv: Pick<Investigation, 'id' | 'title'>): string {
  return `${inv.title} · ${caseNumber(inv.id)}`;
}

export interface Deadline {
  phase: 'open' | 'analysis';
  daysLeft: number;
  /** Days of the phases counted so far (the bar's 100%). */
  totalDays: number;
  dueAt: string;
}

/** The server's deadline of an open case, or null without phases / once decided or archived. */
export function deadlineOf(inv: Investigation): Deadline | null {
  const d = inv.deadline;
  if (!d) return null;
  return { phase: d.phase, daysLeft: d.days_left, totalDays: d.total_days ?? Math.max(d.days_left, 1), dueAt: d.due_at };
}

/** "seleção · 31 d" / "análise · vencido há 2 d". */
export function deadlineText(d: Deadline): string {
  const phase = PHASE_LABELS[d.phase];
  return d.daysLeft < 0 ? `${phase} · vencido há ${-d.daysLeft} d` : `${phase} · ${d.daysLeft} d`;
}

/** Share of the phases already used, 0–100, for the deadline bar. */
export function deadlineElapsed(d: Deadline): number {
  return Math.min(100, Math.max(0, ((d.totalDays - d.daysLeft) / d.totalDays) * 100));
}
