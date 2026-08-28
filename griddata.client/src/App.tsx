import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Spin } from 'antd'
import AppLayout from './components/AppLayout'

// Lazy-load the pages so first paint ships only the shell + the landing route,
// cutting mobile time-to-interactive (the send/receive pages pull heavy code).
const SendPage = lazy(() => import('./pages/SendPage'))
const ReceivePage = lazy(() => import('./pages/ReceivePage'))

const fallback = (
  <div style={{ display: 'grid', placeItems: 'center', minHeight: '40vh' }}><Spin size="large" /></div>
)

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<Suspense fallback={fallback}><SendPage /></Suspense>} />
          <Route path="/receive" element={<Suspense fallback={fallback}><ReceivePage /></Suspense>} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
