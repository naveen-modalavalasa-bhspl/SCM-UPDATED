// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Row, Col, Statistic, Button, List, Tag, Spin, Space, Progress, Empty } from 'antd';
import {
  InboxOutlined,
  CheckSquareOutlined,
  SolutionOutlined,
  AppstoreOutlined,
  PlusOutlined,
  ArrowRightOutlined,
  NotificationOutlined,
  FileTextOutlined,
} from '@ant-design/icons';

import api from '../config/api';
import useAuthStore from '../store/authStore';



const WarehouseDashboard = () => {
  const navigate = useNavigate();
  const hasKey = useAuthStore((s) => s.hasKey);
  const [loading, setLoading] = useState(true);
  const [procSummary, setProcSummary] = useState({});
  const [recentGRNs, setRecentGRNs] = useState([]);
  const [recentQIs, setRecentQIs] = useState([]);

  useEffect(() => {
    fetchDashboardData();
  }, []);

  const fetchDashboardData = async () => {
    try {
      setLoading(true);
      const promises = [api.get('/dashboard/procurement-summary')];
      
      const canViewGRN = hasKey('warehouse-grn');
      const canViewQI = hasKey('warehouse-quality-inspections');

      if (canViewGRN) {
        promises.push(api.get('/warehouse/grn', { params: { page_size: 5 } }));
      } else {
        promises.push(Promise.resolve({ data: { items: [] } }));
      }

      if (canViewQI) {
        promises.push(api.get('/warehouse/quality-inspections', { params: { page_size: 5 } }));
      } else {
        promises.push(Promise.resolve({ data: { items: [] } }));
      }

      const [summaryRes, grnRes, qiRes] = await Promise.all(promises);

      setProcSummary(summaryRes.data || {});
      setRecentGRNs(grnRes.data?.items || grnRes.data || []);
      setRecentQIs(qiRes.data?.items || qiRes.data || []);
    } catch (error) {
      console.error('Failed to load warehouse dashboard data:', error);
    } finally {
      setLoading(false);
    }
  };



  const getStatusTag = (status) => {
    const map = {
      draft: { color: 'default', label: 'Draft' },
      pending_qi: { color: 'orange', label: 'Pending QA' },
      putaway_pending: { color: 'blue', label: 'Pending Putaway' },
      completed: { color: 'green', label: 'Completed' },
      passed: { color: 'green', label: 'QA Passed' },
      failed: { color: 'red', label: 'QA Failed' },
      cancelled: { color: 'default', label: 'Cancelled' },
    };
    const conf = map[status] || { color: 'default', label: status };
    return <Tag color={conf.color}>{conf.label}</Tag>;
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
        <Spin size="large">
          <div style={{ padding: '64px', textAlign: 'center', color: '#6C757D' }}>Loading Warehouse Dashboard...</div>
        </Spin>
      </div>
    );
  }

  const grnStats = procSummary.grns || {};

  return (
    <div style={{ padding: '24px', background: '#F8F9FA', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '28px', color: '#1A1A1A', fontWeight: 600 }}>Warehouse Dashboard</h1>
          <p style={{ margin: 0, color: '#6C757D' }}>Manage goods receipts, QA inspections, bin mapping, putaway, and dispatch queues.</p>
        </div>
        {hasKey('warehouse-grn') && (
          <Space>
            <Button 
              type="primary" 
              icon={<PlusOutlined />} 
              onClick={() => navigate('/warehouse/grn/new')}
              style={{ background: '#F09000', borderColor: '#F09000', height: '40px', borderRadius: '6px' }}
            >
              Receive GRN
            </Button>
          </Space>
        )}
      </div>

      {/* KPI Cards Row */}
      <Row gutter={[16, 16]} style={{ marginBottom: '24px' }}>
        <Col xs={24} sm={12} md={6}>
          <Card 
            hoverable 
            styles={{ body: { padding: '20px' } }}
            style={{ borderRadius: '8px', borderLeft: '4px solid #F09000', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
          >
            <Statistic
              title={<span style={{ color: '#6C757D', fontWeight: 500 }}>GRNs Pending Putaway</span>}
              value={grnStats.putaway_pending ?? 0}
              prefix={<InboxOutlined style={{ color: '#F09000', marginRight: '8px' }} />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={6}>
          <Card 
            hoverable 
            styles={{ body: { padding: '20px' } }}
            style={{ borderRadius: '8px', borderLeft: '4px solid #fa8c16', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
          >
            <Statistic
              title={<span style={{ color: '#6C757D', fontWeight: 500 }}>Pending QA Inspections</span>}
              value={grnStats.pending_qi ?? 0}
              prefix={<CheckSquareOutlined style={{ color: '#fa8c16', marginRight: '8px' }} />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={6}>
          <Card 
            hoverable 
            styles={{ body: { padding: '20px' } }}
            style={{ borderRadius: '8px', borderLeft: '4px solid #52c41a', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
          >
            <Statistic
              title={<span style={{ color: '#6C757D', fontWeight: 500 }}>Active Picklists</span>}
              value={procSummary.warehouse_ops?.active_picklists ?? 0}
              prefix={<SolutionOutlined style={{ color: '#52c41a', marginRight: '8px' }} />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={6}>
          <Card 
            hoverable 
            styles={{ body: { padding: '20px' } }}
            style={{ borderRadius: '8px', borderLeft: '4px solid #1890ff', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
          >
            <Statistic
              title={<span style={{ color: '#6C757D', fontWeight: 500 }}>Picked & Unissued</span>}
              value={procSummary.warehouse_ops?.picked_unissued ?? 0}
              prefix={<AppstoreOutlined style={{ color: '#1890ff', marginRight: '8px' }} />}
            />
          </Card>
        </Col>
      </Row>



      {/* Recent Activity / Quick Actions Row */}
      {(() => {
        const canViewGRN = hasKey('warehouse-grn');
        const showOperations = hasKey('warehouse-grn') || hasKey('warehouse-quality-inspections') || hasKey('warehouse-material-issues') || hasKey('warehouse-notifications');
        
        if (!canViewGRN && !showOperations) return null;
        
        const grnSpan = 16;
        const opsSpan = canViewGRN ? 8 : 24;

        return (
          <Row gutter={[16, 16]}>
            {/* Recent GRNs */}
            {canViewGRN && (
              <Col xs={24} md={grnSpan}>
                <Card 
                  title="Recent Goods Receipt Notes" 
                  extra={<Button type="link" onClick={() => navigate('/warehouse/grn')}>View All</Button>}
                  style={{ borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
                >
                  {recentGRNs.length > 0 ? (
                    <List
                      itemLayout="horizontal"
                      dataSource={recentGRNs}
                      renderItem={(item) => (
                        <List.Item
                          actions={[
                            <Button 
                              type="link" 
                              icon={<ArrowRightOutlined />} 
                              onClick={() => navigate(`/warehouse/grn/${item.id}`)}
                            />
                          ]}
                        >
                          <List.Item.Meta
                            title={
                              <Space>
                                <a onClick={() => navigate(`/warehouse/grn/${item.id}`)} style={{ fontWeight: 600, color: '#1A1A1A' }}>
                                  {item.grn_number}
                                </a>
                                {getStatusTag(item.status)}
                              </Space>
                            }
                            description={
                              <div style={{ fontSize: '13px', color: '#6C757D' }}>
                                <span>Vendor: {item.vendor_name}</span>
                                <span style={{ margin: '0 8px' }}>|</span>
                                <span>Date: {item.grn_date}</span>
                                <span style={{ margin: '0 8px' }}>|</span>
                                <span>Warehouse: {item.warehouse_name || `Warehouse ${item.warehouse_id}`}</span>
                              </div>
                            }
                          />
                        </List.Item>
                      )}
                    />
                  ) : (
                    <Empty description="No recent GRNs found." />
                  )}
                </Card>
              </Col>
            )}

            {/* Quick Actions Panel */}
            {showOperations && (
              <Col xs={24} md={opsSpan}>
                <Card 
                  title="Warehouse Operations" 
                  style={{ borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {hasKey('warehouse-grn') && (
                      <Button 
                        type="primary" 
                        icon={<PlusOutlined />} 
                        onClick={() => navigate('/warehouse/grn/new')}
                        block
                        style={{ background: '#F09000', borderColor: '#F09000', height: '45px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '15px', borderRadius: '6px' }}
                      >
                        Inward New GRN
                      </Button>
                    )}
                    {hasKey('warehouse-quality-inspections') && (
                      <Button 
                        icon={<CheckSquareOutlined />} 
                        onClick={() => navigate('/warehouse/quality-inspection/new')}
                        block
                        style={{ height: '45px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '15px', borderRadius: '6px' }}
                      >
                        New Quality Check
                      </Button>
                    )}
                    {hasKey('warehouse-material-issues') && (
                      <Button 
                        icon={<PlusOutlined />} 
                        onClick={() => navigate('/warehouse/material-issues/new')}
                        block
                        style={{ height: '45px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '15px', borderRadius: '6px' }}
                      >
                        Issue Raw Materials
                      </Button>
                    )}
                    {hasKey('warehouse-notifications') && (
                      <Button 
                        icon={<NotificationOutlined />} 
                        onClick={() => navigate('/warehouse/notifications')}
                        block
                        style={{ height: '45px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '15px', borderRadius: '6px' }}
                      >
                        Warehouse Alerts
                      </Button>
                    )}
                  </div>
                </Card>
              </Col>
            )}
          </Row>
        );
      })()}
    </div>
  );
};

export default WarehouseDashboard;
