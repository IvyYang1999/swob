import { useEffect } from 'react'
import { useStore } from './store'
import { Sidebar } from './components/Sidebar'
import { ChatViewer } from './components/ChatViewer'
import { InfoPanel } from './components/InfoPanel'
import { Toolbar } from './components/Toolbar'
import { SearchResults } from './components/SearchResults'

export default function App() {
  const { initialize, loading, searchQuery } = useStore()

  useEffect(() => {
    initialize()
  }, [initialize])

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-zinc-900 text-zinc-400">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-2 border-zinc-600 border-t-zinc-300 rounded-full mx-auto mb-3" />
          <div className="text-sm">Loading sessions...</div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col bg-zinc-900 text-white">
      <Toolbar />
      <div className="flex-1 flex overflow-hidden relative">
        <Sidebar />
        <ChatViewer />
        <InfoPanel />
        {searchQuery && <SearchResults />}
      </div>
    </div>
  )
}
