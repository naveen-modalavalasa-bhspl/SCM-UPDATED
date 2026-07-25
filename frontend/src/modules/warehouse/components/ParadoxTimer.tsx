// @ts-nocheck
import React from 'react';
import { Card, Space, Tag, Typography } from 'antd';
import { HourglassOutlined } from '@ant-design/icons';

const { Title, Text } = Typography;

const ParadoxTimer = ({ moduleName, description }) => {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      minHeight: '65vh',
      padding: '24px',
      background: 'radial-gradient(circle at center, #0f172a 0%, #020617 100%)',
      borderRadius: '16px',
      overflow: 'hidden',
      position: 'relative',
    }}>
      {/* CSS Stylesheet Injector for Custom Animations */}
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes pulse-glow {
          0%, 100% {
            box-shadow: 0 0 15px rgba(99, 102, 241, 0.2), inset 0 0 15px rgba(99, 102, 241, 0.1);
            border-color: rgba(99, 102, 241, 0.4);
          }
          50% {
            box-shadow: 0 0 30px rgba(139, 92, 246, 0.4), inset 0 0 20px rgba(139, 92, 246, 0.2);
            border-color: rgba(139, 92, 246, 0.7);
          }
        }
        @keyframes text-flicker {
          0%, 100% { opacity: 1; text-shadow: 0 0 8px rgba(139, 92, 246, 0.6); }
          45% { opacity: 1; }
          50% { opacity: 0.85; text-shadow: 0 0 2px rgba(139, 92, 246, 0.2); }
          55% { opacity: 1; }
        }
        @keyframes float-slow {
          0%, 100% { transform: translateY(0px) rotate(0deg); }
          50% { transform: translateY(-10px) rotate(2deg); }
        }
        @keyframes spin-reverse {
          0% { transform: rotate(360deg); }
          100% { transform: rotate(0deg); }
        }
        .paradox-card {
          backdrop-filter: blur(12px);
          background: rgba(15, 23, 42, 0.65) !important;
          border: 1px solid rgba(99, 102, 241, 0.3);
          border-radius: 20px !important;
          animation: pulse-glow 4s infinite ease-in-out;
          max-width: 650px;
          width: 100%;
          text-align: center;
          padding: 40px 20px;
          z-index: 10;
        }
      `}} />

      {/* Decorative background grid */}
      <div style={{
        position: 'absolute',
        top: 0, left: 0, right: 0, bottom: 0,
        backgroundImage: 'linear-gradient(to right, rgba(99, 102, 241, 0.05) 1px, transparent 1px), linear-gradient(to bottom, rgba(99, 102, 241, 0.05) 1px, transparent 1px)',
        backgroundSize: '30px 30px',
        opacity: 0.8,
        pointerEvents: 'none',
      }} />

      <Card className="paradox-card" variant="borderless">
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          {/* Rotating Hourglass Icon */}
          <div style={{ display: 'inline-block', margin: '0 auto' }}>
            <div style={{
              width: '80px',
              height: '80px',
              borderRadius: '50%',
              background: 'rgba(139, 92, 246, 0.1)',
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              border: '1px dashed rgba(139, 92, 246, 0.5)',
              animation: 'spin-reverse 12s infinite linear',
            }}>
              <HourglassOutlined style={{ fontSize: '36px', color: '#a78bfa' }} />
            </div>
          </div>

          {/* Stabilizing Timeline Tag */}
          <div style={{ animation: 'float-slow 3s infinite ease-in-out' }}>
            <Tag color="purple" style={{ border: 'none', fontWeight: 'bold', padding: '4px 16px', borderRadius: '12px' }}>
              STABILIZING TIMELINE
            </Tag>
          </div>

          {/* Module Title */}
          <div>
            <Title level={2} style={{ color: '#f8fafc', margin: '0 0 12px 0', letterSpacing: '0.05em' }}>
              {moduleName}
            </Title>
            <Tag color="geekblue" style={{ fontSize: '0.95rem', padding: '6px 16px', borderRadius: '4px', textTransform: 'uppercase', letterSpacing: '0.1em', animation: 'text-flicker 5s infinite' }}>
              Feature Coming Soon
            </Tag>
          </div>

          {/* Description */}
          <div style={{ padding: '0 20px' }}>
            <Text style={{ color: '#94a3b8', fontSize: '1.05rem', lineHeight: '1.6', display: 'block' }}>
              {description}
            </Text>
          </div>
        </Space>
      </Card>
    </div>
  );
};

export default ParadoxTimer;
