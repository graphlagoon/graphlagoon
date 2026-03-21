<script setup lang="ts">
import { ref, computed } from 'vue';
import { ICON_CATEGORIES } from '@/utils/IconAtlas';
import {
  // People
  User, UserCheck, UserX, UserPlus, UserMinus, UserSearch, UserStar,
  UserKey, UserLock, UserCog, UserPen, UserRound, Users, UsersRound,
  CircleUserRound,
  // Organizations
  Building2, Store, Landmark, Factory, Briefcase, BriefcaseBusiness,
  // Money
  Banknote, BanknoteArrowDown, BanknoteArrowUp, BanknoteX,
  Coins, HandCoins, PiggyBank,
  // Cards & Wallets
  CreditCard, IdCard, IdCardLanyard, CardSim,
  Wallet, WalletCards, WalletMinimal,
  // Transactions
  CircleDollarSign, Receipt, BadgePercent, TrendingUp, TrendingDown,
  ArrowLeftRight, Repeat,
  // Security
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
  // UI
  X,
} from 'lucide-vue-next';

defineProps<{
  modelValue: string | null;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string | null): void;
}>();

const showPicker = ref(false);
const searchQuery = ref('');

// Map icon names to Vue components (must match IconAtlas names)
const iconComponents: Record<string, unknown> = {
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

const isSearching = computed(() => searchQuery.value.length > 0);

/** When searching: flat filtered list matching icon name or category label/aliases */
const filteredIcons = computed(() => {
  const q = searchQuery.value.toLowerCase();
  if (!q) return [];

  const results: string[] = [];
  for (const cat of ICON_CATEGORIES) {
    // If query matches category label or aliases, include ALL icons from that category
    const categoryMatch = cat.label.toLowerCase().includes(q)
      || cat.aliases.some(a => a.includes(q));

    for (const name of cat.icons) {
      if (categoryMatch || name.includes(q)) {
        results.push(name);
      }
    }
  }
  return results;
});

function selectIcon(name: string | null) {
  emit('update:modelValue', name);
  showPicker.value = false;
  searchQuery.value = '';
}

function togglePicker() {
  showPicker.value = !showPicker.value;
  if (!showPicker.value) searchQuery.value = '';
}
</script>

<template>
  <div class="icon-picker-wrapper">
    <button
      class="icon-picker-trigger"
      :title="modelValue ? `Icon: ${modelValue}` : 'No icon'"
      @click="togglePicker"
    >
      <component
        v-if="modelValue && iconComponents[modelValue]"
        :is="iconComponents[modelValue]"
        :size="14"
      />
      <span v-else class="no-icon">--</span>
    </button>

    <div v-if="showPicker" class="icon-picker-popover">
      <div class="icon-picker-header">
        <input
          v-model="searchQuery"
          type="text"
          placeholder="Search icons..."
          class="icon-search"
        />
        <button class="icon-close-btn" @click="togglePicker">
          <X :size="12" />
        </button>
      </div>

      <div class="icon-picker-body">
        <!-- "None" option always visible -->
        <div class="icon-grid icon-grid-none">
          <button
            class="icon-option icon-option-none"
            :class="{ selected: modelValue === null }"
            title="No icon"
            @click="selectIcon(null)"
          >
            --
          </button>
        </div>

        <!-- Search results: flat grid -->
        <template v-if="isSearching">
          <div v-if="filteredIcons.length === 0" class="no-results">
            No icons found
          </div>
          <div v-else class="icon-grid">
            <button
              v-for="name in filteredIcons"
              :key="name"
              class="icon-option"
              :class="{ selected: name === modelValue }"
              :title="name"
              @click="selectIcon(name)"
            >
              <component
                v-if="iconComponents[name]"
                :is="iconComponents[name]"
                :size="16"
              />
            </button>
          </div>
        </template>

        <!-- No search: grouped by category -->
        <template v-else>
          <div
            v-for="cat in ICON_CATEGORIES"
            :key="cat.label"
            class="icon-category"
          >
            <div class="category-header">{{ cat.label }}</div>
            <div class="icon-grid">
              <button
                v-for="name in cat.icons"
                :key="name"
                class="icon-option"
                :class="{ selected: name === modelValue }"
                :title="name"
                @click="selectIcon(name)"
              >
                <component
                  v-if="iconComponents[name]"
                  :is="iconComponents[name]"
                  :size="16"
                />
              </button>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.icon-picker-wrapper {
  position: relative;
}

.icon-picker-trigger {
  width: 28px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  cursor: pointer;
  background: var(--bg-color, #fff);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-color, #333);
  flex-shrink: 0;
}

.icon-picker-trigger:hover {
  border-color: var(--color-primary, #42b883);
}

.no-icon {
  font-size: 10px;
  color: var(--text-muted, #999);
}

.icon-picker-popover {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 100;
  width: 240px;
  max-height: 340px;
  background: var(--card-background, #fff);
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  display: flex;
  flex-direction: column;
  margin-top: 4px;
}

.icon-picker-header {
  display: flex;
  gap: 4px;
  padding: 6px;
  border-bottom: 1px solid var(--border-color, #ddd);
  flex-shrink: 0;
}

.icon-search {
  flex: 1;
  padding: 4px 6px;
  font-size: 11px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 3px;
  outline: none;
  background: var(--bg-color, #fff);
  color: var(--text-color, #333);
}

.icon-search:focus {
  border-color: var(--color-primary, #42b883);
}

.icon-close-btn {
  border: none;
  background: none;
  cursor: pointer;
  padding: 2px;
  color: var(--text-muted, #666);
  display: flex;
  align-items: center;
}

.icon-picker-body {
  overflow-y: auto;
  padding: 4px 6px 6px;
}

.icon-category {
  margin-bottom: 4px;
}

.category-header {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted, #888);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 4px 2px 2px;
  border-bottom: 1px solid var(--border-color-light, #eee);
  margin-bottom: 2px;
}

.icon-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
}

.icon-grid-none {
  margin-bottom: 4px;
}

.icon-option {
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  background: none;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-color, #333);
}

.icon-option:hover {
  background: var(--hover-bg, #f0f0f0);
  border-color: var(--border-color, #ddd);
}

.icon-option.selected {
  background: var(--color-primary-light, #e8f5e9);
  border-color: var(--color-primary, #42b883);
}

.icon-option-none {
  font-size: 10px;
  color: var(--text-muted, #999);
}

.no-results {
  font-size: 11px;
  color: var(--text-muted, #999);
  text-align: center;
  padding: 12px 0;
}
</style>
