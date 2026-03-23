import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import type { TocEntry } from '../utils/markdown'

// Extract plain text from React children for slug generation
function getTextContent(node: React.ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(getTextContent).join('')
  if (node && typeof node === 'object' && 'props' in node) {
    return getTextContent((node as React.ReactElement).props.children)
  }
  return ''
}

// Shared code block/inline code components
function CodeBlock({ children }: { children?: React.ReactNode }) {
  return (
    <div className="bg-surface/80 border border-edge/50 rounded-md p-2.5 my-1.5 overflow-x-auto max-h-60 overflow-y-auto">
      <pre className="text-[12px] font-mono text-body whitespace-pre">{children}</pre>
    </div>
  )
}

function InlineCode({ children }: { children?: React.ReactNode }) {
  return (
    <code className="bg-hover/50 px-1 py-0.5 rounded text-[12px] font-mono text-soft-emerald">
      {children}
    </code>
  )
}

// CLI-style: headings are bold but NOT enlarged
const cliComponents: Components = {
  h1: ({ children }) => <div className="font-bold text-primary mt-3 mb-1">{children}</div>,
  h2: ({ children }) => <div className="font-bold text-primary mt-2.5 mb-1">{children}</div>,
  h3: ({ children }) => <div className="font-bold text-primary mt-2 mb-0.5">{children}</div>,
  h4: ({ children }) => <div className="font-semibold text-body mt-1.5 mb-0.5">{children}</div>,
  h5: ({ children }) => <div className="font-semibold text-body mt-1 mb-0.5">{children}</div>,
  h6: ({ children }) => <div className="font-semibold text-secondary mt-1 mb-0.5">{children}</div>,
  p: ({ children }) => <p className="mb-1.5 leading-relaxed">{children}</p>,
  strong: ({ children }) => <strong className="font-bold text-bright">{children}</strong>,
  em: ({ children }) => <em className="italic text-body">{children}</em>,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  code: ({ className, children }) => {
    if (className) return <code className="text-[12px] font-mono text-body">{children}</code>
    return <InlineCode>{children}</InlineCode>
  },
  ul: ({ children }) => <ul className="list-disc pl-5 mb-1.5 space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 mb-1.5 space-y-0.5">{children}</ol>,
  li: ({ children }) => <li className="text-body leading-relaxed">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-edge-strong pl-3 my-1.5 text-secondary italic">{children}</blockquote>
  ),
  a: ({ href, children }) => (
    <a href={href} className="text-soft-blue hover:underline" target="_blank" rel="noopener noreferrer">{children}</a>
  ),
  hr: () => <hr className="border-edge my-3" />,
  table: ({ children }) => (
    <div className="overflow-x-auto my-1.5">
      <table className="border-collapse border border-edge text-xs w-full">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-surface">{children}</thead>,
  th: ({ children }) => <th className="border border-edge px-2 py-1 text-body font-medium text-left">{children}</th>,
  td: ({ children }) => <td className="border border-edge px-2 py-1 text-secondary">{children}</td>,
}

// Typora-style: heading components need IDs for TOC navigation
function createDocComponents(tocEntries: TocEntry[]): Components {
  let headingIdx = 0

  const getNextId = (): string | undefined => {
    const idx = headingIdx++
    if (tocEntries.length === 0) return undefined
    return tocEntries[idx]?.id || `h-${idx}`
  }

  return {
    h1: ({ children }) => (
      <h1 id={getNextId()} className="text-2xl font-bold text-bright mt-8 mb-4 pb-2 border-b border-edge scroll-mt-12">
        {children}
      </h1>
    ),
    h2: ({ children }) => (
      <h2 id={getNextId()} className="text-xl font-bold text-primary mt-6 mb-3 pb-1.5 border-b border-edge/50 scroll-mt-12">
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 id={getNextId()} className="text-lg font-bold text-primary mt-5 mb-2 scroll-mt-12">{children}</h3>
    ),
    h4: ({ children }) => (
      <h4 id={getNextId()} className="text-base font-bold text-body mt-4 mb-1.5 scroll-mt-12">{children}</h4>
    ),
    h5: ({ children }) => (
      <h5 id={getNextId()} className="text-sm font-bold text-soft-blue mt-4 mb-1 flex items-center gap-2 scroll-mt-12">
        <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
        {children}
      </h5>
    ),
    h6: ({ children }) => (
      <h6 id={getNextId()} className="text-sm font-semibold text-secondary mt-2 mb-1 scroll-mt-12">{children}</h6>
    ),
    p: ({ children }) => <p className="mb-2 leading-relaxed text-body">{children}</p>,
    strong: ({ children }) => <strong className="font-bold text-bright">{children}</strong>,
    em: ({ children }) => <em className="italic text-secondary">{children}</em>,
    pre: ({ children }) => (
      <div className="bg-base border border-edge/60 rounded-lg p-3 my-2 overflow-x-auto max-h-80 overflow-y-auto">
        <pre className="text-[12px] font-mono text-body whitespace-pre">{children}</pre>
      </div>
    ),
    code: ({ className, children }) => {
      if (className) return <code className="text-[12px] font-mono text-body">{children}</code>
      return <InlineCode>{children}</InlineCode>
    },
    ul: ({ children }) => <ul className="list-disc pl-5 mb-2 space-y-1">{children}</ul>,
    ol: ({ children }) => <ol className="list-decimal pl-5 mb-2 space-y-1">{children}</ol>,
    li: ({ children }) => <li className="text-body leading-relaxed">{children}</li>,
    blockquote: ({ children }) => (
      <blockquote className="border-l-3 border-edge-strong pl-4 my-2 py-1 text-secondary bg-surface/30 rounded-r-md">
        {children}
      </blockquote>
    ),
    a: ({ href, children }) => (
      <a href={href} className="text-soft-blue hover:text-soft-blue hover:underline" target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ),
    hr: () => <hr className="border-edge/60 my-6" />,
    table: ({ children }) => (
      <div className="overflow-x-auto my-2">
        <table className="border-collapse border border-edge text-sm w-full">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-surface">{children}</thead>,
    th: ({ children }) => <th className="border border-edge px-3 py-1.5 text-body font-medium text-left">{children}</th>,
    td: ({ children }) => <td className="border border-edge px-3 py-1.5 text-secondary">{children}</td>,
  }
}

export function CliMarkdown({ content }: { content: string }) {
  return (
    <div className="text-sm text-primary">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={cliComponents}>
        {content}
      </ReactMarkdown>
    </div>
  )
}

export function DocMarkdown({ content, tocEntries }: { content: string; tocEntries: TocEntry[] }) {
  // Components are recreated each render to reset the heading counter
  const components = createDocComponents(tocEntries)
  return (
    <div className="text-sm text-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
