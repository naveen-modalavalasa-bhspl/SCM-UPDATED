// @ts-nocheck
import React, { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button, Select, Space, Progress, Tag, Popconfirm, Tooltip, App
} from 'antd';
import {
  EyeOutlined, PlayCircleOutlined, PlusOutlined
} from '@ant-design/icons';
import PageHeader from '../components/PageHeader';
import DataTable from '../components/DataTable';
import StatusTag from '../components/StatusTag';
import api from '../config/api';
import {
  formatDateTime, getErrorMessage
} from '../utils/helpers';

const PUTAWAY_STATUSES = [
  { label: 'Pending', value: 'pending' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'Completed', value: 'completed' },
  { label: 'Cancelled', value: 'cancelled' },
];

const Putaway = () => {
  const { message: antMessage } = App.useApp();
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);

  // Filters
  const [filterStatus, setFilterStatus] = useState(undefined);
  const [filterWarehouse, setFilterWarehouse] = useState(undefined);
  const [warehouses, setWarehouses] = useState([]);

  // --- Load Warehouses ---
  const loadWarehouses = useCallback(async () => {
    try {
      const res = await api.get('/masters/warehouses', { params: { page_size: 200 } });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setWarehouses(items.map((w) => ({ label: w.name || w.warehouse_name, value: w.id })));
    } catch {
      // silent
    }
  }, []);

  // --- Fetch Putaways ---
  const fetchPutaways = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterStatus) qp.status = filterStatus;
      if (filterWarehouse) qp.warehouse_id = filterWarehouse;
      return await api.get('/warehouse/putaways', { params: qp });
    },
    [filterStatus, filterWarehouse]
  );

  // --- Main Table Columns ---
  const columns = [
    {
      title: 'Putaway Number',
      dataIndex: 'putaway_number',
      key: 'putaway_number',
      width: 160,
      sorter: true,
      fixed: 'left',
      render: (text, record) => <a onClick={() => navigate(`/warehouse/putaway/${record.id}`)}>{text}</a>,
    },
    {
      title: 'GRN Reference',
      dataIndex: 'grn_number',
      key: 'grn_number',
      width: 150,
      render: (v) => v || '-',
    },
    {
      title: 'Warehouse',
      dataIndex: 'warehouse_name',
      key: 'warehouse',
      width: 140,
      ellipsis: true,
      render: (v) => v || '-',
    },
    {
      title: 'Putaway Type',
      dataIndex: 'putaway_type',
      key: 'putaway_type',
      width: 130,
      render: (v) => {
        const typeMap = { system_directed: 'System Directed', manual: 'Manual' };
        return <Tag color={v === 'system_directed' ? 'blue' : 'orange'}>{typeMap[v] || v || '-'}</Tag>;
      },
    },
    {
      title: 'Assigned To',
      dataIndex: 'assigned_to_name',
      key: 'assigned_to',
      width: 140,
      render: (v, r) => v || r.assigned_to || '-',
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (s) => <StatusTag status={s} />,
    },
    {
      title: 'Progress',
      key: 'progress',
      width: 120,
      render: (_, record) => {
        const total = record.total_items || 0;
        const done = record.completed_items || 0;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        return <Progress percent={pct} size="small" format={() => `${done}/${total}`} />;
      },
    },
    {
      title: 'Started At',
      dataIndex: 'started_at',
      key: 'started_at',
      width: 140,
      sorter: true,
      render: (v) => v ? formatDateTime(v) : '-',
    },
    {
      title: 'Completed At',
      dataIndex: 'completed_at',
      key: 'completed_at',
      width: 140,
      sorter: true,
      render: (v) => v ? formatDateTime(v) : '-',
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 120,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="View / Execute Putaway">
            <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => navigate(`/warehouse/putaway/${record.id}`)} />
          </Tooltip>
          {(record.status === 'draft' || record.status === 'pending') && (
            <Tooltip title="Start Putaway">
              <Popconfirm title="Start this putaway?" onConfirm={async () => {
                try {
                  await api.put(`/warehouse/putaways/${record.id}/start`);
                  antMessage.success('Putaway started');
                  setRefreshKey((k) => k + 1);
                } catch (err) { antMessage.error(getErrorMessage(err)); }
              }}>
                <Button type="link" size="small" icon={<PlayCircleOutlined />} style={{ color: '#eb2f96' }} />
              </Popconfirm>
            </Tooltip>
          )}
        </Space>
      ),
    },
  ];

  // --- Filter Toolbar ---
  const toolbar = (
    <Space style={{ marginLeft: 12 }} wrap>
      <Select
        placeholder="Status"
        allowClear
        style={{ width: 140 }}
        value={filterStatus}
        onChange={(v) => { setFilterStatus(v); setRefreshKey((k) => k + 1); }}
        options={PUTAWAY_STATUSES}
      />
      <Select
        placeholder="Warehouse"
        allowClear
        showSearch
        optionFilterProp="label"
        style={{ width: 160 }}
        value={filterWarehouse}
        onChange={(v) => { setFilterWarehouse(v); setRefreshKey((k) => k + 1); }}
        options={warehouses}
        onOpenChange={(open) => { if (open && warehouses.length === 0) loadWarehouses(); }}
      />
    </Space>
  );

  return (
    <div>
      <PageHeader title="Putaway" subtitle="Manage putaway operations for received goods">
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/warehouse/putaway/new')}>
            Create Putaway
          </Button>
        </Space>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchPutaways}
        rowKey="id"
        searchPlaceholder="Search by putaway number, GRN..."
        exportFileName="putaway_list"
        toolbar={toolbar}
        scroll={{ x: 1500 }}
      />
    </div>
  );
};

export default Putaway;

