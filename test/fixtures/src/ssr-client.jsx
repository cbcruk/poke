import { hydrateRoot } from 'react-dom/client'
import { App } from './ssr-app'

// A large or late bundle: the server HTML is on screen well before React takes it over.
const delay = Number(new URLSearchParams(location.search).get('delay') ?? 0)
// A negative delay never hydrates, like a bundle that failed to load.
if (delay >= 0) setTimeout(() => hydrateRoot(document.getElementById('root'), <App />), delay)
