#!/usr/bin/env node
/**
 * build-perplexity-pdf.mjs — one-off PDF build for report 002 (Perplexity FDE).
 *
 * Phase 4 smoke test: does the template + generate-pdf.mjs pipeline work end-to-end?
 *
 * Not a reusable builder — content is inlined per the Block E personalization
 * plan in reports/002-perplexity-fde-applied-ai-2026-04-22.md. A proper builder
 * would consume cv.md + a JD-derived rewrite spec; that's Phase 5 work.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(__dirname, 'templates/cv-template.html');
const OUT_HTML = resolve(__dirname, 'output/cv-ben-thorpe-perplexity.html');
const OUT_PDF = resolve(__dirname, 'output/cv-ben-thorpe-perplexity-2026-04-22.pdf');

mkdirSync(resolve(__dirname, 'output'), { recursive: true });

const template = readFileSync(TEMPLATE_PATH, 'utf8');

// --- Content slots (tailored for Perplexity MTS FDE) ---

const summaryText =
  'Forward-deployed AI engineer shipping production LLM systems against messy real-world artifacts. ' +
  'Most recent: a 3-stage Prior-Auth policy pipeline on Neo4j knowledge graphs delivering 97% runtime reduction ' +
  'and 90% cost reduction vs. the prior system, enabled by deterministic PDF structure detection that cut per-document LLM calls from 84+ to 5-15. ' +
  'Yale MA Stats / Duke BS Data Science. Looking for a high-leverage AI engineering role embedded with customers in NYC.';

const competencies = [
  'Forward Deployed Engineering',
  'Production LLM systems',
  'Prompt engineering & evals',
  'Agent & retrieval frameworks',
  'APIs & distributed systems',
  'AWS serverless architecture',
  'Python / TypeScript / Go',
  'Regulated-industry AI (healthcare)',
];

const experienceBlocks = [
  {
    company: 'ZS',
    role: 'Advanced Data Science Associate',
    location: 'New York, NY',
    period: 'September 2025 - Present',
    bullets: [
      'Built a <strong>3-stage NLP pipeline</strong> that extracts clinical criteria from Prior Authorization policy PDFs into a <strong>Neo4j knowledge graph</strong>, achieving a <strong>97% runtime reduction</strong> and <strong>90% cost reduction</strong> vs. the prior system',
      'Engineered <strong>deterministic PDF structure detection</strong> using hierarchical marker inference and table promotion, cutting per-document LLM calls from <strong>84+ to 5-15</strong> while preserving extraction accuracy - the cost and runtime lever behind the PA pipeline above',
      'Developed an <strong>automated clinical trials database generator</strong> combining web-scraping and LLM prompting to produce standardized drug efficacy and safety metrics, with <strong>z-score normalization</strong> enabling cross-indication comparison',
    ],
  },
  {
    company: 'Pro Training Center',
    role: 'Freelance Software Engineer',
    location: 'Remote',
    period: 'January 2026 - Present',
    bullets: [
      '<strong>Direct-to-customer deployment</strong> of a production SaaS platform for professional basketball player-development coaches, transforming unstructured scouting notes into <strong>AI-enhanced reports</strong> via custom prompts that preserve authentic coaching voice',
      'Built the full stack solo (<strong>Flask, PostgreSQL, React/TypeScript</strong>) with role-based workflows (assistant to head coach to player), video management on <strong>Cloudflare R2</strong>, and async report generation via <strong>AWS SQS</strong>',
      'Integrated third-party APIs to <strong>auto-populate player stats and advanced shooting data</strong> inside generated scouting reports',
    ],
  },
  {
    company: 'Variance Inc.',
    role: 'Data Scientist',
    location: 'Remote',
    period: 'September 2025 - Present',
    bullets: [
      'Shipped an <strong>end-to-end soccer match prediction system</strong> across 42,000+ matches and 20 leagues on a serverless model-fitting pipeline using <strong>AWS Lambda (Go), CloudFormation, and S3</strong>',
      'Built the full-stack analytics dashboard on <strong>React + AWS Cognito</strong>, with event-driven data refresh via <strong>Lambda, SQS, and EventBridge</strong> serving xG statistics across 19 leagues',
    ],
  },
  {
    company: 'Big League Advantage',
    role: 'Data Science Intern',
    location: 'Washington, D.C.',
    period: 'May 2021 - July 2024',
    bullets: [
      '<strong>Modeled original team play-style metrics</strong> to separate and measure player-vs-team effects in support of an English professional soccer club\'s decision-making',
      'Produced a <strong>hyperparameter-tuned ML model</strong> (<strong>XGBoost</strong> + <strong>HyperOpt</strong>) to predict the conference level of future college basketball players, feeding a player-level betting model',
    ],
  },
];

const projects = [
  {
    title: 'Senior Thesis - SHAP Variable Importance on an Event-Level Soccer ML Model',
    badge: 'Duke - High Distinction',
    desc: 'Completed a variable-importance analysis on an event-level soccer ML model using <strong>SHAP values</strong> and updated the model framework to support a new, more detailed data version.',
    tech: 'github.com/benthorpe33/VAEP_Thesis',
  },
  {
    title: 'USA Gymnastics Olympic Lineup Optimizer',
    badge: 'UConn Sports Analytics Symposium - Won Undergrad Division',
    desc: 'Designed a <strong>simulation-based approach</strong> to predict the best lineups for the USA Men\'s and Women\'s gymnastics teams for Paris 2024, with an interactive web-app for arbitrary team scenarios. <strong>Presented at the US Olympic & Paralympic Performance Innovation Summit</strong> (December 2024).',
    tech: 'github.com/seanmtli/usa_gymnastics',
  },
  {
    title: 'ASIC 2025 - High Defensive Lines in Women\'s Professional Soccer',
    badge: 'American Soccer Insights Conference Presenter',
    desc: 'Leveraged <strong>player-tracking data</strong> to quantify the effectiveness of high defensive lines in women\'s professional soccer. Presented at ASIC 2025.',
    tech: '',
  },
];

const educationItems = [
  {
    title: 'M.A. Statistics',
    org: 'Yale University',
    year: '2024 - 2025',
    desc: '',
  },
  {
    title: 'B.S. Data Science; Certificate in Innovation and Entrepreneurship',
    org: 'Duke University',
    year: '2020 - 2024',
    desc: 'Co-President and Co-Founder of Duke Sports Analytics Club',
  },
];

const skillsRows = [
  { cat: 'Languages', items: 'Python, SQL, Go, TypeScript/JavaScript, R' },
  { cat: 'AI / ML', items: 'LLM orchestration, prompt engineering, evals, Neo4j knowledge graphs, RAG-adjacent retrieval, XGBoost, HyperOpt, SHAP, simulation modeling' },
  { cat: 'AWS', items: 'Lambda (Go + Python), SQS, EventBridge, Cognito, S3, CloudFormation' },
  { cat: 'Data / Web', items: 'PostgreSQL, Flask, React, Cloudflare R2' },
];

// --- HTML fragment builders ---

const experienceHtml = experienceBlocks.map((j) => `
    <div class="job avoid-break">
      <div class="job-header">
        <span class="job-company">${j.company}</span>
        <span class="job-period">${j.period}</span>
      </div>
      <div class="job-role">${j.role} <span class="job-location">- ${j.location}</span></div>
      <ul>
        ${j.bullets.map((b) => `<li>${b}</li>`).join('\n        ')}
      </ul>
    </div>
`).join('\n');

const projectsHtml = projects.map((p) => `
    <div class="project avoid-break">
      <div class="project-title">${p.title}<span class="project-badge">${p.badge}</span></div>
      <div class="project-desc">${p.desc}</div>
      ${p.tech ? `<div class="project-tech">${p.tech}</div>` : ''}
    </div>
`).join('\n');

const educationHtml = educationItems.map((e) => `
    <div class="edu-item avoid-break">
      <div class="edu-header">
        <span class="edu-title">${e.title} - <span class="edu-org">${e.org}</span></span>
        <span class="edu-year">${e.year}</span>
      </div>
      ${e.desc ? `<div class="edu-desc">${e.desc}</div>` : ''}
    </div>
`).join('\n');

const skillsHtml = `
    <div class="skills-grid" style="flex-direction: column; gap: 4px;">
      ${skillsRows.map((s) => `<div class="skill-item"><span class="skill-category">${s.cat}:</span> ${s.items}</div>`).join('\n      ')}
    </div>
`;

const competenciesHtml = competencies.map((c) => `<span class="competency-tag">${c}</span>`).join('\n      ');

// --- Replace tokens ---

const replacements = {
  '{{LANG}}': 'en',
  '{{PAGE_WIDTH}}': '8.5in',
  '{{NAME}}': 'Benjamin Thorpe',
  '{{PHONE}}': '',
  '{{EMAIL}}': 'Ben.thorpe.ds@gmail.com',
  '{{LINKEDIN_URL}}': 'https://linkedin.com/in/ben-thorpe',
  '{{LINKEDIN_DISPLAY}}': 'linkedin.com/in/ben-thorpe',
  '{{PORTFOLIO_URL}}': 'https://github.com/benthorpe33',
  '{{PORTFOLIO_DISPLAY}}': 'github.com/benthorpe33',
  '{{LOCATION}}': 'New York, NY',
  '{{SECTION_SUMMARY}}': 'Professional Summary',
  '{{SUMMARY_TEXT}}': summaryText,
  '{{SECTION_COMPETENCIES}}': 'Core Competencies',
  '{{COMPETENCIES}}': competenciesHtml,
  '{{SECTION_EXPERIENCE}}': 'Work Experience',
  '{{EXPERIENCE}}': experienceHtml,
  '{{SECTION_PROJECTS}}': 'Projects',
  '{{PROJECTS}}': projectsHtml,
  '{{SECTION_EDUCATION}}': 'Education',
  '{{EDUCATION}}': educationHtml,
  '{{SECTION_CERTIFICATIONS}}': 'Certifications',
  '{{CERTIFICATIONS}}': '<div class="cert-item"><span class="cert-title">(none listed)</span></div>',
  '{{SECTION_SKILLS}}': 'Skills',
  '{{SKILLS}}': skillsHtml,
};

let html = template;
for (const [k, v] of Object.entries(replacements)) {
  html = html.split(k).join(v);
}

// Drop the phone <span> and its trailing separator — template hardcodes `<span>{{PHONE}}</span><span class="separator">|</span>`.
// After {{PHONE}} is replaced with '', we have `<span></span><span class="separator">|</span>` — clean it up.
html = html.replace(
  /<span>\s*<\/span>\s*<span class="separator">\|<\/span>\s*/,
  ''
);

// Drop certifications section since Ben has none (cleaner than showing an empty "none listed" row)
html = html.replace(
  /<!-- CERTIFICATIONS -->[\s\S]*?<\/div>\s*<\/div>\s*(?=<!-- SKILLS -->)/,
  ''
);

writeFileSync(OUT_HTML, html);
console.log(`Wrote ${OUT_HTML}`);

// Now render to PDF
console.log('Rendering PDF...');
try {
  execFileSync('node', ['generate-pdf.mjs', OUT_HTML, OUT_PDF, '--format=letter'], {
    cwd: __dirname,
    stdio: 'inherit',
  });
  console.log(`Done: ${OUT_PDF}`);
} catch (err) {
  console.error('PDF generation failed:', err.message);
  process.exit(1);
}
