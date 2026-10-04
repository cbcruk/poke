import { renderToString } from 'react-dom/server'
import { App } from './ssr-app'

export const render = () => renderToString(<App />)
