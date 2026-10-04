import { useReducer, useState } from 'react'
import { createRoot } from 'react-dom/client'

function Counter({ label }) {
  const [count, setCount] = useState(0)
  const [todo, dispatch] = useReducer((state, patch) => ({ ...state, ...patch }), { done: false })
  return (
    <button id="counter" onClick={() => setCount((c) => c + 1)}>
      {label}: {count} {todo.done ? 'done' : 'todo'}
    </button>
  )
}

function App() {
  return (
    <main>
      <h1>React</h1>
      <Counter label="클릭" />
    </main>
  )
}

createRoot(document.getElementById('root')).render(<App />)
