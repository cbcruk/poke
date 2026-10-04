import { useState } from 'react'

export function App() {
  const [count, setCount] = useState(0)
  return (
    <main>
      <h1>SSR</h1>
      <button id="inc" onClick={() => setCount((c) => c + 1)}>count: {count}</button>
    </main>
  )
}
