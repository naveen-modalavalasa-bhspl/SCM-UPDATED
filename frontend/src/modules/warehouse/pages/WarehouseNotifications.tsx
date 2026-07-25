// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, List, Button, Tag, Spin, message, Empty, Space } from 'antd';
import { CheckOutlined, BellOutlined, ClockCircleOutlined, RightOutlined } from '@ant-design/icons';
import api from '../config/api';
import PageHeader from '../components/PageHeader';
import { formatDate } from '../utils/helpers';

const WarehouseNotifications = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    fetchNotifications();
  }, []);

  const fetchNotifications = async () => {
    try {
      setLoading(true);
      const res = await api.get('/notifications', { params: { module: 'warehouse', page_size: 100 } });
      const items = res.data?.items || res.data?.data || res.data || [];
      setNotifications(items);
      setUnreadCount(items.filter(n => !n.is_read).length);
    } catch (error) {
      message.error('Failed to load notifications');
    } finally {
      setLoading(false);
    }
  };

  const handleMarkAsRead = async (id) => {
    try {
      await api.post(`/notifications/${id}/read`);
      message.success('Notification marked as read');
      setNotifications(prev => 
        prev.map(n => n.id === id ? { ...n, is_read: true } : n)
      );
      setUnreadCount(c => Math.max(0, c - 1));
    } catch {
      message.error('Failed to update notification status');
    }
  };

  const handleMarkAllAsRead = async () => {
    try {
      await api.post('/notifications/read-all');
      message.success('All notifications marked as read');
      setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
      setUnreadCount(0);
    } catch {
      message.error('Failed to update notifications');
    }
  };

  const getAlertIcon = (type) => {
    const map = {
      warning: '⚠️',
      error: '🛑',
      success: '✅',
      approval: '⏳',
      info: 'ℹ️',
    };
    return map[type] || '🔔';
  };

  const getTagColor = (type) => {
    const map = {
      warning: 'warning',
      error: 'error',
      success: 'success',
      approval: 'processing',
      info: 'default',
    };
    return map[type] || 'default';
  };

  const handleRowClick = (item) => {
    if (!item.reference_id) return;
    
    switch (item.reference_type) {
      case 'grn':
        navigate(`/warehouse/grn/${item.reference_id}`);
        break;
      case 'qi':
      case 'quality_inspection':
        navigate(`/warehouse/quality-inspection/${item.reference_id}`);
        break;
      case 'putaway':
        navigate(`/warehouse/putaway/${item.reference_id}`);
        break;
      case 'material_issue':
        navigate(`/warehouse/material-issues/${item.reference_id}`);
        break;
      default:
        break;
    }
  };

  return (
    <div style={{ padding: '24px' }}>
      <PageHeader
        title="Warehouse Alerts & Notifications"
        subtitle={`You have ${unreadCount} unread warehouse warnings and workflow notifications.`}
      >
        {unreadCount > 0 && (
          <Button 
            type="primary" 
            icon={<CheckOutlined />} 
            onClick={handleMarkAllAsRead}
            style={{ background: '#F09000', borderColor: '#F09000', borderRadius: '6px' }}
          >
            Mark All as Read
          </Button>
        )}
      </PageHeader>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '100px' }}>
          <Spin size="large" tip="Retrieving warehouse alerts inbox..." />
        </div>
      ) : (
        <Card style={{ borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.03)' }}>
          {notifications.length > 0 ? (
            <List
              itemLayout="horizontal"
              dataSource={notifications}
              renderItem={(item) => (
                <List.Item
                  style={{
                    padding: '16px',
                    background: item.is_read ? 'transparent' : 'rgba(240, 144, 0, 0.02)',
                    borderBottom: '1px solid #F0F0F0',
                    cursor: item.reference_id ? 'pointer' : 'default',
                    transition: 'all 0.2s',
                  }}
                  actions={[
                    !item.is_read && (
                      <Button 
                        type="text" 
                        icon={<CheckOutlined />} 
                        onClick={(e) => {
                          e.stopPropagation();
                          handleMarkAsRead(item.id);
                        }}
                        title="Mark as read"
                      />
                    ),
                    item.reference_id && (
                      <Button 
                        type="link" 
                        icon={<RightOutlined />} 
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRowClick(item);
                        }}
                      />
                    ),
                  ]}
                  onClick={() => handleRowClick(item)}
                >
                  <List.Item.Meta
                    avatar={
                      <div style={{ fontSize: '24px', padding: '4px' }}>
                        {getAlertIcon(item.type)}
                      </div>
                    }
                    title={
                      <Space>
                        <span style={{ fontWeight: item.is_read ? 500 : 700, color: '#1A1A1A' }}>
                          {item.title}
                        </span>
                        <Tag color={getTagColor(item.type)} style={{ textTransform: 'capitalize' }}>
                          {item.type}
                        </Tag>
                      </Space>
                    }
                    description={
                      <div style={{ marginTop: '4px' }}>
                        <div style={{ color: '#495057', fontSize: '14px', marginBottom: '4px' }}>
                          {item.message}
                        </div>
                        <div style={{ fontSize: '12px', color: '#6C757D', display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <ClockCircleOutlined />
                          <span>{formatDate(item.created_at)}</span>
                        </div>
                      </div>
                    }
                  />
                </List.Item>
              )}
            />
          ) : (
            <Empty 
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <div style={{ padding: '24px' }}>
                  <BellOutlined style={{ fontSize: '40px', color: '#C0C0C0', marginBottom: '12px' }} />
                  <div>No alerts or notifications in your Warehouse inbox.</div>
                </div>
              }
            />
          )}
        </Card>
      )}
    </div>
  );
};

export default WarehouseNotifications;
