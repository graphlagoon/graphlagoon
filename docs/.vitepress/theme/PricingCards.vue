<template>
  <div class="pricing-section">
    <h2 class="pricing-title">Plans</h2>
    <p class="pricing-subtitle">100% open-source. Self-hosted on your own Databricks infrastructure.</p>
    <div class="pricing-grid">
      <div
        v-for="plan in plans"
        :key="plan.name"
        class="pricing-card"
        :class="{ highlighted: plan.highlighted }"
      >
        <div class="card-header">
          <h3>{{ plan.name }}</h3>
          <div class="price">{{ plan.price }}</div>
        </div>
        <p class="card-description">{{ plan.description }}</p>
        <ul class="features-list">
          <li v-for="feature in plan.features" :key="feature">{{ feature }}</li>
        </ul>
        <a v-if="plan.link" :href="plan.link" class="card-action">{{ plan.action }}</a>
      </div>
    </div>
  </div>
</template>

<script setup>
const sharedFeatures = [
  'Open-source (AGPL-3.0)',
  'All features included',
  'Zero ETL — query Delta tables directly',
  'Databricks Apps deployment',
  'Built-in authentication',
  'Setup in a few lines of code',
]

const plans = [
  {
    name: 'Community',
    price: 'Free',
    description: 'Full platform, self-hosted on your Databricks infrastructure.',
    features: sharedFeatures,
    link: '/guide/getting-started',
    action: 'Get Started',
  },
  {
    name: 'Team',
    price: 'Free',
    description: 'Full platform, self-hosted on your Databricks infrastructure.',
    features: sharedFeatures,
    link: '/guide/getting-started',
    action: 'Get Started',
  },
  {
    name: 'Enterprise',
    price: 'Free',
    description: 'Full platform, self-hosted on your Databricks infrastructure.',
    features: sharedFeatures,
    link: '/guide/getting-started',
    action: 'Get Started',
  },
  {
    name: 'Consulting',
    price: 'Custom',
    description: 'We can help you from scratch — from graph data modeling and data analysis with PhDs in the field to prioritizing bugs and features.',
    highlighted: true,
    features: [
      'Implementation & deployment',
      'Graph data modeling for your domain',
      'Data analysis by domain experts',
      'Priority bug fixes & feature requests',
    ],
    link: 'mailto:devmessias@gmail.com',
    action: 'Contact Us',
  },
]
</script>

<style scoped>
.pricing-section {
  max-width: 1152px;
  margin: 64px auto 0;
  padding: 0 24px 64px;
  text-align: center;
}

.pricing-title {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.pricing-subtitle {
  color: var(--vp-c-text-2);
  margin-top: 8px;
  margin-bottom: 32px;
  font-size: 16px;
}

.pricing-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
}

@media (max-width: 960px) {
  .pricing-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 560px) {
  .pricing-grid {
    grid-template-columns: 1fr;
  }
}

.pricing-card {
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  padding: 24px;
  text-align: left;
  display: flex;
  flex-direction: column;
  background: var(--vp-c-bg-soft);
  transition: border-color 0.3s;
}

.pricing-card:hover {
  border-color: var(--vp-c-brand-1);
}

.pricing-card.highlighted {
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 0 0 1px var(--vp-c-brand-1);
}

.card-header h3 {
  font-size: 18px;
  font-weight: 600;
  margin: 0;
}

.price {
  font-size: 32px;
  font-weight: 700;
  color: var(--vp-c-brand-1);
  margin-top: 8px;
}

.card-description {
  color: var(--vp-c-text-2);
  font-size: 14px;
  margin-top: 12px;
  flex-grow: 0;
}

.features-list {
  list-style: none;
  padding: 0;
  margin: 16px 0;
  flex-grow: 1;
}

.features-list li {
  position: relative;
  padding-left: 20px;
  font-size: 14px;
  line-height: 2;
  color: var(--vp-c-text-1);
}

.features-list li::before {
  content: '✓';
  position: absolute;
  left: 0;
  color: var(--vp-c-brand-1);
  font-weight: 700;
}

.card-action {
  display: block;
  text-align: center;
  padding: 10px 16px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;
  transition: background 0.3s, color 0.3s;
  border: 1px solid var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}

.card-action:hover {
  background: var(--vp-c-brand-1);
  color: #fff;
}

.highlighted .card-action {
  background: var(--vp-c-brand-1);
  color: #fff;
}

.highlighted .card-action:hover {
  background: var(--vp-c-brand-2);
}
</style>
