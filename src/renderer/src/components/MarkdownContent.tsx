import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'

// CLI-style: headings are bold but NOT enlarged, just like terminal output
const cliComponents: Components = {
  h1: ({ children }) => <div className="font-bold text-zinc-200 mt-3 mb-1">{children}</div>,
  h2: ({ children }) => <div className="font-bold text-zinc-200 mt-2.5 mb-1">{children}</div>,
  h3: ({ children }) => <div className="font-bold text-zinc-200 mt-2 mb-0.5">{children}</div>,
  h4: ({ children }) => <div className="font-semibold text-zinc-300 mt-1.5 mb-0.5">{children}</div>,
  h5: ({ children }) => <div className="font-semibold text-zinc-300 mt-1 mb-0.5">{children}</div>,
  h6: ({ children }) => <div className="font-semibold text-zinc-400 mt-1 mb-0.5">{children}</div>,
  p: ({ children }) => <p className="mb-1.5 leading-relaxed">{children}</p>,
  strong: ({ children }) => <strong className="font-bold text-zinc-100">{children}</strong>,
  em: ({ children }) => <em className="italic text-zinc-300">{children}</em>,
  pre: ({ children }) => (
    <div className="bg-zinc-800/80 border border-zinc-700/50 rounded-md p-2.5 my-1.5 overflow-x-auto max-h-60 overflow-y-auto">
      <pre className="text-[12px] font-mono text-zinc-300 whitespace-pre">{children}</pre>
    </div>
  ),
  code: ({ className, children }) => {
    if (className) {
      return <code className="text-[12px] font-mono text-zinc-300">{children}</code>
    }
    return (
      <code className="bg-zinc-700/50 px-1 py-0.5 rounded text-[12px] font-mono text-emerald-400">
        {children}
      </code>
    )
  },
  ul: ({ children }) => <ul className="list-disc pl-5 mb-1.5 space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 mb-1.5 space-y-0.5">{children}</ol>,
  li: ({ children }) => <li className="text-zinc-300 leading-relaxed">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-zinc-600 pl-3 my-1.5 text-zinc-400 italic">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      className="text-blue-400 hover:underline"
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="border-zinc-700 my-3" />,
  table: ({ children }) => (
    <div className="overflow-x-auto my-1.5">
      <table className="border-collapse border border-zinc-700 text-xs w-full">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-zinc-800">{children}</thead>,
  th: ({ children }) => (
    <th className="border border-zinc-700 px-2 py-1 text-zinc-300 font-medium text-left">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border border-zinc-700 px-2 py-1 text-zinc-400">{children}</td>
  ),
}

// Typora-style: proper heading sizes, document-like feel
const docComponents: Components = {
  h1: ({ children }) => (
    <h1 className="text-2xl font-bold text-zinc-100 mt-8 mb-4 pb-2 border-b border-zinc-700">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-xl font-bold text-zinc-200 mt-6 mb-3 pb-1.5 border-b border-zinc-700/50">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-lg font-bold text-zinc-200 mt-5 mb-2">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="text-base font-bold text-zinc-300 mt-4 mb-1.5">{children}</h4>
  ),
  h5: ({ children }) => (
    <h5 className="text-sm font-bold text-blue-400 mt-4 mb-1 flex items-center gap-2">
      <span className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />
      {children}
    </h5>
  ),
  h6: ({ children }) => (
    <h6 className="text-sm font-semibold text-zinc-400 mt-2 mb-1">{children}</h6>
  ),
  p: ({ children }) => <p className="mb-2 leading-relaxed text-zinc-300">{children}</p>,
  strong: ({ children }) => <strong className="font-bold text-zinc-100">{children}</strong>,
  em: ({ children }) => <em className="italic text-zinc-400">{children}</em>,
  pre: ({ children }) => (
    <div className="bg-zinc-900 border border-zinc-700/60 rounded-lg p-3 my-2 overflow-x-auto max-h-80 overflow-y-auto">
      <pre className="text-[12px] font-mono text-zinc-300 whitespace-pre">{children}</pre>
    </div>
  ),
  code: ({ className, children }) => {
    if (className) {
      return <code className="text-[12px] font-mono text-zinc-300">{children}</code>
    }
    return (
      <code className="bg-zinc-700/40 px-1.5 py-0.5 rounded text-[12px] font-mono text-emerald-400">
        {children}
      </code>
    )
  },
  ul: ({ children }) => <ul className="list-disc pl-5 mb-2 space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 mb-2 space-y-1">{children}</ol>,
  li: ({ children }) => <li className="text-zinc-300 leading-relaxed">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-3 border-zinc-600 pl-4 my-2 py-1 text-zinc-400 bg-zinc-800/30 rounded-r-md">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      className="text-blue-400 hover:text-blue-300 hover:underline"
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="border-zinc-700/60 my-6" />,
  table: ({ children }) => (
    <div className="overflow-x-auto my-2">
      <table className="border-collapse border border-zinc-700 text-sm w-full">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-zinc-800">{children}</thead>,
  th: ({ children }) => (
    <th className="border border-zinc-700 px-3 py-1.5 text-zinc-300 font-medium text-left">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border border-zinc-700 px-3 py-1.5 text-zinc-400">{children}</td>
  ),
}

export function CliMarkdown({ content }: { content: string }) {
  return (
    <div className="text-sm text-zinc-200">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={cliComponents}>
        {content}
      </ReactMarkdown>
    </div>
  )
}

export function DocMarkdown({ content }: { content: string }) {
  return (
    <div className="text-sm text-zinc-300">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={docComponents}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
