/**
 * Case presets (05 §4b): vocabularies a `kind_preset` suggests, never imposes.
 * Twin of `services/cases.py::PRESET_DEFAULTS` (the server fills `settings.vocabularies`
 * at creation; this copy serves cases created before and the settings drawer).
 */
import type { KindPreset } from '@/types/investigation';

export interface CaseVocabulary {
  roles: string[];
  tags: string[];
  /** Attributes Vínculos offers first: property names or attribute node types. */
  link_attributes: string[];
}

export const PRESET_DEFAULTS: Record<KindPreset, CaseVocabulary> = {
  credito: { roles: ['controlador', 'coligada', 'garantidor', 'devedor'], tags: [], link_attributes: ['endereco', 'telefone', 'email'] },
  garantia: { roles: ['devedor', 'adquirente', 'cessionário', 'bem'], tags: [], link_attributes: ['endereco', 'email'] },
  pix_med: { roles: ['vítima', 'mula', 'beneficiário final', 'ponto de saque'], tags: [], link_attributes: ['telefone', 'device_id'] },
  lavagem: { roles: ['origem', 'passagem', 'destino', 'laranja'], tags: [], link_attributes: ['endereco', 'telefone'] },
  lojista: { roles: ['lojista', 'sócio', 'adquirente', 'terminal'], tags: [], link_attributes: ['terminal', 'endereco', 'telefone'] },
  fraude_sintetica: {
    roles: ['identidade real', 'identidade sintética', 'mula', 'ponto de cash-out'],
    tags: [],
    link_attributes: ['telefone', 'email', 'device_id', 'endereco'],
  },
  livre: { roles: [], tags: [], link_attributes: [] },
};

/** The case's vocabulary: its settings, else the preset's defaults. */
export function vocabularyOf(settings: Record<string, unknown> | undefined, preset: KindPreset | undefined): CaseVocabulary {
  const own = (settings?.vocabularies ?? {}) as Partial<CaseVocabulary>;
  const base = PRESET_DEFAULTS[preset ?? 'livre'] ?? PRESET_DEFAULTS.livre;
  return { roles: own.roles ?? base.roles, tags: own.tags ?? base.tags, link_attributes: own.link_attributes ?? base.link_attributes };
}

/** The 8 group colors (05 §5). */
export const GROUP_COLORS = ['#0f766e', '#2563eb', '#db2777', '#ea580c', '#65a30d', '#8b5cf6', '#0891b2', '#a16207'];

export function groupColor(color: string | number | undefined, index = 0): string {
  if (typeof color === 'string' && color) return color;
  const i = typeof color === 'number' ? color : index;
  return GROUP_COLORS[((i % GROUP_COLORS.length) + GROUP_COLORS.length) % GROUP_COLORS.length];
}

/** What the agent writes as "suggested" (05 §6); the rest applies directly. */
export const SUGGEST_KINDS = ['role', 'tag', 'hypothesis_status', 'same_as', 'status_change', 'typology', 'group', 'note'] as const;
export const DEFAULT_SUGGEST_KINDS = ['role', 'tag', 'hypothesis_status', 'same_as', 'status_change', 'typology'];
