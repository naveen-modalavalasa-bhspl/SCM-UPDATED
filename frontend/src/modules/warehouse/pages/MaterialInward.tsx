// @ts-nocheck
import React, { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button, Select, Space, Table, Popconfirm, message, Tag,
} from 'antd';
import {
  PlusOutlined, EyeOutlined, CheckCircleOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../components/PageHeader';
import DataTable from '../components/DataTable';
import StatusTag from '../components/StatusTag';
import api from '../config/api';
import { getErrorMessage } from '../utils/helpers';

const MaterialInward = () => {
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);

  // Lookups
  const [warehouses, setWarehouses] = useState([]);

  // Filters
  const [filterStatus, setFilterStatus] = useState(undefined);
  const [filterWarehouse, setFilterWarehouse] = useState(undefined);

  useEffect(() => {
    fetchWarehouses();
  }, []);

  const fetchInwards = useCallback(
    async (params) => {
      const queryParams = { ...params };
      if (filterStatus) queryParams.status = filterStatus;
      if (filterWarehouse) queryParams.warehouse_id = filterWarehouse;
      return await api.get('/warehouse/inwards', { params: queryParams });
    },
    [filterStatus, filterWarehouse, refreshKey]
  );

  const handleAdd = () => {
    navigate('/warehouse/material-inward/new');
  };

  const handleView = (record) => {
    navigate(`/warehouse/material-inward/${record.id}`);
  };

  const handleComplete = async (id) => {
    try {
      await api.post(`/warehouse/inwards/${id}/complete`);
      message.success('Material Inward marked as received');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const statusColor = (s) => {
    switch (s) {
      case 'draft': return 'default';
      case 'received': return 'green';
      case 'grn_created': return 'blue';
      case 'cancelled': return 'red';
      default: return 'default';
    }
  };

  const columns = [
    {
      title: 'Inward #',
      dataIndex: 'inward_number',
      key: 'inward_number',
      width: 150,
      sorter: true,
      fixed: 'left',
      render: (text, record) => (
        <a onClick={() => handleView(record)}>{text}</a>
      ),
    },
    {
      title: 'PO Number',
      dataIndex: 'po_number',
      key: 'po_number',
      width: 140,
      render: (v) => v || '-',
    },
    {
      title: 'Vendor',
      key: 'vendor',
      width: 200,
      ellipsis: true,
      render: (_, record) => record.vendor_name || record.vendor_name_manual || '-',
    },
    {
      title: 'Warehouse',
      dataIndex: 'warehouse_name',
      key: 'warehouse_name',
      width: 160,
      render: (v) => v || '-',
    },
    {
      title: 'Received Date',
      dataIndex: 'received_date',
      key: 'received_date',
      width: 140,
      render: (v) => v ? dayjs(v).format('DD-MMM-YYYY') : '-',
    },
    {
      title: 'Vehicle #',
      dataIndex: 'vehicle_number',
      key: 'vehicle_number',
      width: 130,
      render: (v) => v || '-',
    },
    {
      title: 'Items',
      key: 'item_count',
      width: 80,
      align: 'center',
      render: (_, record) => (record.items || []).length,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (v) => <Tag color={statusColor(v)}>{(v || 'draft').toUpperCase()}</Tag>,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 160,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleView(record)} />
          {record.status === 'draft' && (
            <Popconfirm
              title="Mark as received?"
              description="This will update the status to 'Received'."
              onConfirm={() => handleComplete(record.id)}
              okText="Confirm"
            >
              <Button type="link" size="small" icon={<CheckCircleOutlined />} style={{ color: '#52c41a' }} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const toolbar = (
    <Space style={{ marginLeft: 12 }}>
      <Select
        placeholder="Status"
        allowClear
        style={{ width: 140 }}
        value={filterStatus}
        onChange={(v) => { setFilterStatus(v); setRefreshKey((k) => k + 1); }}
        options={[
          { label: 'Draft', value: 'draft' },
          { label: 'Received', value: 'received' },
          { label: 'GRN Created', value: 'grn_created' },
          { label: 'Cancelled', value: 'cancelled' },
        ]}
      />
      <Select
        placeholder="Warehouse"
        allowClear
        showSearch
        optionFilterProp="label"
        style={{ width: 180 }}
        value={filterWarehouse}
        onChange={(v) => { setFilterWarehouse(v); setRefreshKey((k) => k + 1); }}
        options={warehouses}
      />
    </Space>
  );

  const fetchWarehouses = async () => {
    try {
      const res = await api.get('/masters/warehouses', { params: { page_size: 500 } });
      const data = res.data;
      const list = data.items || data.data || (Array.isArray(data) ? data : []);
      setWarehouses(list.map((w) => ({ label: w.name, value: w.id })));
    } catch { /* silent */ }
  };

  return (
    <div>
      <PageHeader title="Material Inward" subtitle="Record incoming materials at the warehouse">
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
          New Inward
        </Button>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchInwards}
        rowKey="id"
        searchPlaceholder="Search by inward number, PO number..."
        toolbar={toolbar}
        scroll={{ x: 1200 }}
      />


    </div>
  );
};

export default MaterialInward;
