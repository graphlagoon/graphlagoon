import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import PricingCards from './PricingCards.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }: Parameters<NonNullable<Theme['enhanceApp']>>[0]) {
    app.component('PricingCards', PricingCards)
  },
} satisfies Theme
