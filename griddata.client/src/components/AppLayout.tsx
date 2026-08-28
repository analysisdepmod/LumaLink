import { Segmented, Space } from 'antd'
import { SendOutlined, CameraOutlined } from '@ant-design/icons'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'

export default function AppLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const selected = location.pathname === '/receive' ? '/receive' : '/'

  return (
    <div style={{ minHeight: '100vh' }}>
      <header className="gd-header">
        <div style={{
          maxWidth: 1080, margin: '0 auto', padding: '12px 20px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap',
        }}>
          <Space size={12} align="center">
            <div className="opt-logo" aria-label="LumaLink Stellar Aperture"><span /><i /><b /></div>
            <div style={{ lineHeight: 1.1 }}>
              <div className="gd-brand" style={{ fontSize: 22 }}>LumaLink</div>
              <div className="opt-brand-subtitle">OPTICAL TRANSFER CHANNEL</div>
            </div>
          </Space>

          <Segmented
            value={selected}
            onChange={(v) => navigate(v as string)}
            size="large"
            options={[
              { label: 'إرسال', value: '/', icon: <SendOutlined /> },
              { label: 'استقبال', value: '/receive', icon: <CameraOutlined /> },
            ]}
          />
        </div>
      </header>

      <main className="gd-content">
        <Outlet />
      </main>
    </div>
  )
}
