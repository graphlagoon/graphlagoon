/**
 * IconAtlas - Builds a texture atlas from Lucide icon SVG data at runtime.
 *
 * Uses Canvas 2D to rasterize a curated set of Lucide icons into a single
 * texture atlas (640x640). Each icon is rendered as white strokes on transparent
 * background. The atlas is consumed by FastIconRenderer for GPU-instanced
 * billboard rendering.
 *
 * Icons are organized into semantic categories for fintech domain use.
 */

import * as THREE from 'three';
import {
  // People (expanded)
  User, UserCheck, UserX, UserPlus, UserMinus, UserSearch, UserStar,
  UserKey, UserLock, UserCog, UserPen, UserRound, Users, UsersRound,
  CircleUserRound,
  // Organizations
  Building2, Store, Landmark, Factory, Briefcase, BriefcaseBusiness,
  // Money (expanded)
  Banknote, BanknoteArrowDown, BanknoteArrowUp, BanknoteX,
  Coins, HandCoins, PiggyBank,
  // Cards & Wallets (expanded)
  CreditCard, IdCard, IdCardLanyard, CardSim,
  Wallet, WalletCards, WalletMinimal,
  // Transactions
  CircleDollarSign, Receipt, BadgePercent, TrendingUp, TrendingDown,
  ArrowLeftRight, Repeat,
  // Security - Shield (expanded)
  Shield, ShieldAlert, ShieldBan, ShieldCheck, ShieldX, ShieldOff,
  ShieldPlus, ShieldQuestion, ShieldUser, ShieldHalf, ShieldMinus,
  // Fraud & Alerts
  AlertTriangle, OctagonAlert, Ban, Skull, Siren, Bug,
  // Identity & Auth
  Key, Lock, Fingerprint, Eye, ScanFace,
  // Devices
  Smartphone, Laptop, Monitor, Cpu, Wifi,
  // Communication
  Mail, Phone, MessageSquare, Bell, Send,
  // Systems
  Database, Server, Cloud, Network, Globe, Link,
  // Documents
  FileText, Folder, Tag, Hash,
  // Location & Time
  MapPin, Calendar, Clock, Flag,
  // Payments
  QrCode, Barcode,
  // Status
  CheckCircle, XCircle, AlertCircle, Info,
  // General
  Activity, Zap, Search, Scale,
} from 'lucide';

export interface IconAtlasEntry {
  u: number;
  v: number;
  w: number;
  h: number;
}

export interface IconCategory {
  label: string;
  /** Search aliases for this category (matched when user searches) */
  aliases: string[];
  icons: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LucideIconData = any;

/** Categorized icon definitions for the atlas and picker UI */
export const ICON_CATEGORIES: IconCategory[] = [
  {
    label: 'People',
    aliases: ['pessoa', 'cliente', 'user', 'person', 'people'],
    icons: [
      'user', 'user-check', 'user-x', 'user-plus', 'user-minus',
      'user-search', 'user-star', 'user-key', 'user-lock', 'user-cog',
      'user-pen', 'user-round', 'users', 'users-round', 'circle-user',
    ],
  },
  {
    label: 'Organizations',
    aliases: ['empresa', 'pj', 'juridica', 'org', 'company'],
    icons: [
      'building', 'store', 'landmark', 'factory', 'briefcase', 'briefcase-business',
    ],
  },
  {
    label: 'Money',
    aliases: ['dinheiro', 'nota', 'banco', 'bank', 'cash', 'money'],
    icons: [
      'banknote', 'banknote-down', 'banknote-up', 'banknote-x',
      'coins', 'hand-coins', 'piggy-bank',
    ],
  },
  {
    label: 'Cards & Wallets',
    aliases: ['cartao', 'carteira', 'card', 'wallet', 'payment'],
    icons: [
      'credit-card', 'id-card', 'id-card-lanyard', 'card-sim',
      'wallet', 'wallet-cards', 'wallet-minimal',
    ],
  },
  {
    label: 'Transactions',
    aliases: ['transacao', 'transfer', 'pagamento', 'financeiro', 'financial'],
    icons: [
      'dollar-sign', 'receipt', 'percent', 'trending-up', 'trending-down',
      'arrow-left-right', 'repeat',
    ],
  },
  {
    label: 'Security',
    aliases: ['seguranca', 'shield', 'protecao', 'security', 'protection'],
    icons: [
      'shield', 'shield-alert', 'shield-ban', 'shield-check', 'shield-x',
      'shield-off', 'shield-plus', 'shield-question', 'shield-user',
      'shield-half', 'shield-minus',
    ],
  },
  {
    label: 'Fraud & Alerts',
    aliases: ['fraude', 'fraud', 'risco', 'risk', 'alerta', 'alert', 'bloqueio'],
    icons: [
      'alert-triangle', 'octagon-alert', 'ban', 'skull', 'siren', 'bug',
    ],
  },
  {
    label: 'Identity & Auth',
    aliases: ['identidade', 'autenticacao', 'identity', 'auth', 'biometria'],
    icons: [
      'key', 'lock', 'fingerprint', 'eye', 'scan-face',
    ],
  },
  {
    label: 'Devices',
    aliases: ['dispositivo', 'device', 'celular', 'computador'],
    icons: [
      'smartphone', 'laptop', 'monitor', 'cpu', 'wifi',
    ],
  },
  {
    label: 'Communication',
    aliases: ['comunicacao', 'contato', 'contact', 'email'],
    icons: [
      'mail', 'phone', 'message', 'bell', 'send',
    ],
  },
  {
    label: 'Systems',
    aliases: ['sistema', 'infra', 'server', 'data'],
    icons: [
      'database', 'server', 'cloud', 'network', 'globe', 'link',
    ],
  },
  {
    label: 'Documents',
    aliases: ['documento', 'arquivo', 'document', 'file'],
    icons: [
      'file-text', 'folder', 'tag', 'hash',
    ],
  },
  {
    label: 'Location & Time',
    aliases: ['localizacao', 'endereco', 'location', 'time', 'tempo', 'data'],
    icons: [
      'map-pin', 'calendar', 'clock', 'flag',
    ],
  },
  {
    label: 'Payments',
    aliases: ['pix', 'boleto', 'qr', 'pagamento'],
    icons: [
      'qr-code', 'barcode',
    ],
  },
  {
    label: 'Status',
    aliases: ['estado', 'status', 'resultado', 'result'],
    icons: [
      'check-circle', 'x-circle', 'alert-circle', 'info',
    ],
  },
  {
    label: 'General',
    aliases: ['geral', 'outro', 'general', 'other'],
    icons: [
      'activity', 'zap', 'search', 'scale',
    ],
  },
];

/** Icon name → Lucide SVG data mapping (for canvas rendering) */
const ICON_DATA_MAP: Record<string, LucideIconData> = {
  // People
  'user': User, 'user-check': UserCheck, 'user-x': UserX,
  'user-plus': UserPlus, 'user-minus': UserMinus, 'user-search': UserSearch,
  'user-star': UserStar, 'user-key': UserKey, 'user-lock': UserLock,
  'user-cog': UserCog, 'user-pen': UserPen, 'user-round': UserRound,
  'users': Users, 'users-round': UsersRound, 'circle-user': CircleUserRound,
  // Organizations
  'building': Building2, 'store': Store, 'landmark': Landmark,
  'factory': Factory, 'briefcase': Briefcase, 'briefcase-business': BriefcaseBusiness,
  // Money
  'banknote': Banknote, 'banknote-down': BanknoteArrowDown,
  'banknote-up': BanknoteArrowUp, 'banknote-x': BanknoteX,
  'coins': Coins, 'hand-coins': HandCoins, 'piggy-bank': PiggyBank,
  // Cards & Wallets
  'credit-card': CreditCard, 'id-card': IdCard, 'id-card-lanyard': IdCardLanyard,
  'card-sim': CardSim, 'wallet': Wallet, 'wallet-cards': WalletCards,
  'wallet-minimal': WalletMinimal,
  // Transactions
  'dollar-sign': CircleDollarSign, 'receipt': Receipt, 'percent': BadgePercent,
  'trending-up': TrendingUp, 'trending-down': TrendingDown,
  'arrow-left-right': ArrowLeftRight, 'repeat': Repeat,
  // Security
  'shield': Shield, 'shield-alert': ShieldAlert, 'shield-ban': ShieldBan,
  'shield-check': ShieldCheck, 'shield-x': ShieldX, 'shield-off': ShieldOff,
  'shield-plus': ShieldPlus, 'shield-question': ShieldQuestion,
  'shield-user': ShieldUser, 'shield-half': ShieldHalf, 'shield-minus': ShieldMinus,
  // Fraud & Alerts
  'alert-triangle': AlertTriangle, 'octagon-alert': OctagonAlert,
  'ban': Ban, 'skull': Skull, 'siren': Siren, 'bug': Bug,
  // Identity & Auth
  'key': Key, 'lock': Lock, 'fingerprint': Fingerprint,
  'eye': Eye, 'scan-face': ScanFace,
  // Devices
  'smartphone': Smartphone, 'laptop': Laptop, 'monitor': Monitor,
  'cpu': Cpu, 'wifi': Wifi,
  // Communication
  'mail': Mail, 'phone': Phone, 'message': MessageSquare,
  'bell': Bell, 'send': Send,
  // Systems
  'database': Database, 'server': Server, 'cloud': Cloud,
  'network': Network, 'globe': Globe, 'link': Link,
  // Documents
  'file-text': FileText, 'folder': Folder, 'tag': Tag, 'hash': Hash,
  // Location & Time
  'map-pin': MapPin, 'calendar': Calendar, 'clock': Clock, 'flag': Flag,
  // Payments
  'qr-code': QrCode, 'barcode': Barcode,
  // Status
  'check-circle': CheckCircle, 'x-circle': XCircle,
  'alert-circle': AlertCircle, 'info': Info,
  // General
  'activity': Activity, 'zap': Zap, 'search': Search, 'scale': Scale,
};

/** Flat list of all icon names (derived from categories, for atlas building) */
export const CURATED_ICON_NAMES: string[] =
  ICON_CATEGORIES.flatMap(cat => cat.icons);

const GRID_SIZE = 10;        // 10x10 grid (100 slots)
const CELL_SIZE = 64;        // 64px per icon cell
const ATLAS_SIZE = GRID_SIZE * CELL_SIZE; // 640px
const ICON_PADDING = 8;      // padding inside each cell

/**
 * Render a single Lucide icon element array onto a canvas context.
 * Lucide icons export arrays like: [["path", { d: "..." }], ["circle", { cx, cy, r }]]
 * The icons use a 24x24 viewBox with stroke-based rendering.
 */
function renderIconToCanvas(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  iconData: LucideIconData,
  x: number,
  y: number,
  size: number,
): void {
  const padding = ICON_PADDING;
  const drawSize = size - padding * 2;
  const scale = drawSize / 24; // Lucide icons are 24x24 viewBox

  ctx.save();
  ctx.translate(x + padding, y + padding);
  ctx.scale(scale, scale);
  ctx.strokeStyle = 'white';
  ctx.fillStyle = 'none';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const [tag, attrs] of iconData) {
    switch (tag) {
      case 'path': {
        const p = new Path2D(attrs.d as string);
        ctx.stroke(p);
        break;
      }
      case 'circle': {
        const cx = Number(attrs.cx);
        const cy = Number(attrs.cy);
        const r = Number(attrs.r);
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case 'rect': {
        const rx = Number(attrs.x || 0);
        const ry = Number(attrs.y || 0);
        const rw = Number(attrs.width);
        const rh = Number(attrs.height);
        const rr = Number(attrs.rx || 0);
        if (rr > 0) {
          ctx.beginPath();
          ctx.roundRect(rx, ry, rw, rh, rr);
          ctx.stroke();
        } else {
          ctx.strokeRect(rx, ry, rw, rh);
        }
        break;
      }
      case 'line': {
        ctx.beginPath();
        ctx.moveTo(Number(attrs.x1), Number(attrs.y1));
        ctx.lineTo(Number(attrs.x2), Number(attrs.y2));
        ctx.stroke();
        break;
      }
      case 'polyline':
      case 'polygon': {
        const points = (attrs.points as string).trim().split(/\s+/).map((p: string) => {
          const [px, py] = p.split(',').map(Number);
          return [px, py] as [number, number];
        });
        if (points.length > 0) {
          ctx.beginPath();
          ctx.moveTo(points[0][0], points[0][1]);
          for (let i = 1; i < points.length; i++) {
            ctx.lineTo(points[i][0], points[i][1]);
          }
          if (tag === 'polygon') ctx.closePath();
          ctx.stroke();
        }
        break;
      }
      case 'ellipse': {
        const ecx = Number(attrs.cx);
        const ecy = Number(attrs.cy);
        const erx = Number(attrs.rx);
        const ery = Number(attrs.ry);
        ctx.beginPath();
        ctx.ellipse(ecx, ecy, erx, ery, 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
    }
  }

  ctx.restore();
}

export class IconAtlas {
  texture: THREE.CanvasTexture;
  entries: Map<string, IconAtlasEntry> = new Map();
  iconNames: string[] = CURATED_ICON_NAMES;
  private _disposed = false;

  constructor() {
    const canvas = new OffscreenCanvas(ATLAS_SIZE, ATLAS_SIZE);
    const ctx = canvas.getContext('2d')!;

    // Clear to transparent
    ctx.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);

    // Render each icon into its grid cell
    const allIcons = CURATED_ICON_NAMES;
    for (let i = 0; i < allIcons.length; i++) {
      const name = allIcons[i];
      const iconData = ICON_DATA_MAP[name];
      if (!iconData) continue;

      const col = i % GRID_SIZE;
      const row = Math.floor(i / GRID_SIZE);
      const x = col * CELL_SIZE;
      const y = row * CELL_SIZE;

      renderIconToCanvas(ctx, iconData, x, y, CELL_SIZE);

      // Store UV coordinates (normalized 0..1)
      this.entries.set(name, {
        u: x / ATLAS_SIZE,
        v: y / ATLAS_SIZE,
        w: CELL_SIZE / ATLAS_SIZE,
        h: CELL_SIZE / ATLAS_SIZE,
      });
    }

    // Create THREE texture from canvas
    this.texture = new THREE.CanvasTexture(canvas as unknown as HTMLCanvasElement);
    this.texture.flipY = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.texture.dispose();
  }
}
