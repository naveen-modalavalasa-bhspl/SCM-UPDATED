// @ts-nocheck
import React, { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button, Select, Space, DatePicker, Popconfirm, Table, Typography, Tooltip, Tag, App
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined,
  CheckOutlined, FileDoneOutlined
} from '@ant-design/icons';
import PageHeader from '../components/PageHeader';
import DataTable from '../components/DataTable';
import StatusTag from '../components/StatusTag';
import api from '../config/api';
import {
  formatDate, formatCurrency, getErrorMessage, formatDateForAPI
} from '../utils/helpers';
import { DATE_FORMAT } from '../utils/constants';

const { Text } = Typography;

const PR_STATUSES = [
  { label: 'Draft', value: 'draft' },
  { label: 'Pending Approval', value: 'pending_approval' },
  { label: 'Approved', value: 'approved' },
  { label: 'Dispatched', value: 'dispatched' },
  { label: 'Completed', value: 'completed' },
  { label: 'Cancelled', value: 'cancelled' },
];

const PurchaseReturns = () => {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);

  // Filters
  const [filterStatus, setFilterStatus] = useState(undefined);
  const [filterVendor, setFilterVendor] = useState(undefined);
  const [filterWarehouse, setFilterWarehouse] = useState(undefined);
  const [filterDateRange, setFilterDateRange] = useState(null);

  const [vendors, setVendors] = useState([]);
  const [warehouses, setWarehouses] = useState([]);

  // --- Lookups ---
  const loadLookups = useCallback(async () => {
    try {
      const [vendorRes, whRes] = await Promise.allSettled([
        api.get('/masters/vendors', { params: { page_size: 200, status: 'active' } }),
        api.get('/masters/warehouses', { params: { page_size: 200 } }),
      ]);
      if (vendorRes.status === 'fulfilled') {
        const d = vendorRes.value.data;
        const items = d.items || d.data || d || [];
        setVendors(items.map((v) => ({
          label: `[${v.vendor_code}] ${v.name}`,
          value: v.id,
        })));
      }
      if (whRes.status === 'fulfilled') {
        const w = whRes.value.data;
        setWarehouses(
          (w.items || w.data || w || []).map((i) => ({
            label: i.name || i.warehouse_name,
            value: i.id,
          }))
        );
      }
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    loadLookups();
  }, [loadLookups]);

  // --- Fetch ---
  const fetchRecords = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterStatus) qp.status = filterStatus;
      if (filterVendor) qp.vendor_id = filterVendor;
      if (filterWarehouse) qp.warehouse_id = filterWarehouse;
      if (filterDateRange && filterDateRange[0]) {
        qp.date_from = formatDateForAPI(filterDateRange[0]);
        qp.date_to = formatDateForAPI(filterDateRange[1]);
      }
      return await api.get('/warehouse/purchase-returns', { params: qp });
    },
    [filterStatus, filterVendor, filterWarehouse, filterDateRange]
  );

  // --- Actions ---
  const handleApprove = async (id) => {
    try {
      await api.post(`/warehouse/purchase-returns/${id}/approve`);
      message.success('Purchase Return approved');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleComplete = async (id) => {
    try {
      await api.post(`/warehouse/purchase-returns/${id}/complete`);
      message.success('Purchase Return completed');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/warehouse/purchase-returns/${id}`);
      message.success('Purchase Return deleted');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // --- Main Table Columns ---
  const columns = [
    {
      title: 'Return Number',
      dataIndex: 'return_number',
      key: 'return_number',
      width: 160,
      sorter: true,
      fixed: 'left',
      render: (text, record) => (
        <a onClick={() => navigate(`/warehouse/purchase-returns/${record.id}`)}>{text}</a>
      ),
    },
    {
      title: 'Vendor',
      dataIndex: 'vendor_name',
      key: 'vendor',
      width: 180,
      ellipsis: true,
      render: (v, r) => v || r.vendor || '-',
    },
    {
      title: 'Warehouse',
      dataIndex: 'warehouse_name',
      key: 'warehouse',
      width: 150,
      ellipsis: true,
      render: (v) => v || '-',
    },
    {
      title: 'Return Date',
      dataIndex: 'return_date',
      key: 'return_date',
      width: 120,
      sorter: true,
      render: (v) => formatDate(v),
    },
    {
      title: 'Reason',
      dataIndex: 'reason',
      key: 'reason',
      width: 200,
      ellipsis: true,
      render: (v) => v || '-',
    },
    {
      title: 'Total Amount',
      dataIndex: 'total_amount',
      key: 'total_amount',
      width: 130,
      align: 'right',
      render: (v) => <Text strong>{formatCurrency(v)}</Text>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 140,
      render: (s) => <StatusTag status={s} />,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 180,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="View Detail">
            <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => navigate(`/warehouse/purchase-returns/${record.id}`)} />
          </Tooltip>
          {record.status === 'draft' && (
            <>
              <Tooltip title="Edit">
                <Button type="link" size="small" icon={<EditOutlined />} onClick={() => navigate(`/warehouse/purchase-returns/${record.id}?edit=true`)} />
              </Tooltip>
              <Tooltip title="Approve">
                <Popconfirm title="Approve this Purchase Return?" onConfirm={() => handleApprove(record.id)}>
                  <Button type="link" size="small" icon={<CheckOutlined />} style={{ color: '#52c41a' }} />
                </Popconfirm>
              </Tooltip>
              <Popconfirm title="Delete this Purchase Return?" onConfirm={() => handleDelete(record.id)} okButtonProps={{ danger: true }}>
                <Button type="link" size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            </>
          )}
          {(record.status === 'approved' || record.status === 'dispatched') && (
            <Tooltip title="Complete">
              <Popconfirm title="Mark this Purchase Return as completed?" onConfirm={() => handleComplete(record.id)}>
                <Button type="link" size="small" icon={<FileDoneOutlined />} style={{ color: '#52c41a' }} />
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
        style={{ width: 160 }}
        value={filterStatus}
        onChange={(v) => { setFilterStatus(v); setRefreshKey((k) => k + 1); }}
        options={PR_STATUSES}
      />
      <Select
        placeholder="Vendor"
        allowClear
        showSearch
        optionFilterProp="label"
        style={{ width: 180 }}
        value={filterVendor}
        onChange={(v) => { setFilterVendor(v); setRefreshKey((k) => k + 1); }}
        options={vendors}
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
      />
      <DatePicker.RangePicker
        value={filterDateRange}
        onChange={(dates) => { setFilterDateRange(dates); setRefreshKey((k) => k + 1); }}
        format={DATE_FORMAT}
        style={{ width: 240 }}
        placeholder={['From Date', 'To Date']}
      />
    </Space>
  );

  return (
    <div>
      <PageHeader title="Purchase Returns" subtitle="Manage purchase returns to vendors">
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/warehouse/purchase-returns/new')}>
            Create Return
          </Button>
        </Space>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchRecords}
        rowKey="id"
        searchPlaceholder="Search by return number, reason..."
        exportFileName="purchase_returns_list"
        toolbar={toolbar}
        scroll={{ x: 1300 }}
      />
    </div>
  );
};

export default PurchaseReturns;

