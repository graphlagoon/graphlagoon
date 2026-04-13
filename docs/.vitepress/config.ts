import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Graph Lagoon Studio',
  description: 'Open-source graph exploration platform for Databricks — zero ETL, zero extra cost, deploy with a few lines of code',
  base: process.env.VITEPRESS_BASE || '/',
  srcExclude: ['dev/**'],

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      {
        text: 'GitHub',
        link: 'https://github.com/graphlagoon/graphlagoon',
      },
    ],

    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting Started', link: '/guide/getting-started' },
          { text: 'Databricks Integration', link: '/guide/integration' },
          { text: 'Similarity System', link: '/guide/similarity' },
          { text: 'Configuration', link: '/guide/configuration' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/graphlagoon/graphlagoon' },
    ],
  },
})
