import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider, theme as antdTheme } from 'antd'
import arEG from 'antd/locale/ar_EG'
import App from './App'
import './theme.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfigProvider
      direction="rtl"
      locale={arEG}
      theme={{
        algorithm: antdTheme.defaultAlgorithm,
        token: {
          fontFamily: '"Segoe UI", Tahoma, "Noto Kufi Arabic", Arial, sans-serif',
          colorPrimary: '#6d5efc',
          colorInfo: '#6d5efc',
          colorSuccess: '#14b8a6',
          borderRadius: 12,
          wireframe: false,
        },
        components: {
          Card: { boxShadowTertiary: '0 6px 24px rgba(30, 27, 75, 0.06)' },
          Button: { controlHeightLG: 48, fontWeight: 600 },
        },
      }}
    >
      <App />
    </ConfigProvider>
  </StrictMode>,
)
