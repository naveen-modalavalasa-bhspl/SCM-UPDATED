// @ts-nocheck
import React, { useState, useEffect, useCallback } from 'react';
import {
  Button, Select, Space, Popconfirm, message, Tag, Typography, Tooltip, DatePicker
} from 'antd';
import {
  PlusOutlined, EyeOutlined, DeleteOutlined,
  ExperimentOutlined, CheckOutlined, CloseCircleOutlined
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import PageHeader from '../components/PageHeader';
import DataTable from '../components/DataTable';
import StatusTag from '../components/StatusTag';
import api from '../config/api';
import {
  formatDate, formatCurrency, formatNumber, getErrorMessage, formatDateForAPI
} from '../utils/helpers';
import { DATE_FORMAT } from '../utils/constants';

const { Text } = Typography;

const GRN_STATUSES = [
  { label: 'Draft', value: 'draft' },
  { label: 'Pending QI', value: 'pending_qi' },
  { label: 'QI In Progress', value: 'qi_in_progress' },
  { label: 'Completed', value: 'completed' },
  { label: 'Cancelled', value: 'cancelled' },
];

const GRN = () => {
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);

  // Filters
  const [filterStatus, setFilterStatus] = useState(undefined);
  const [filterVendor, setFilterVendor] = useState(undefined);
  const [filterWarehouse, setFilterWarehouse] = useState(undefined);
  const [filterDateRange, setFilterDateRange] = useState(null);

  // Lookups
  const [vendors, setVendors] = useState([]);
  const [warehouses, setWarehouses] = useState([]);

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
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    loadLookups();
  }, [loadLookups]);

  const fetchGRNs = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterStatus) qp.status = filterStatus;
      if (filterVendor) qp.vendor_id = filterVendor;
      if (filterWarehouse) qp.warehouse_id = filterWarehouse;
      if (filterDateRange && filterDateRange[0]) {
        qp.date_from = formatDateForAPI(filterDateRange[0]);
        qp.date_to = formatDateForAPI(filterDateRange[1]);
      }
      return await api.get('/warehouse/grn', { params: qp });
    },
    [filterStatus, filterVendor, filterWarehouse, filterDateRange]
  );

  const handleAdd = () => {
    navigate('/warehouse/grn/new');
  };

  const handleView = (record) => {
    navigate(`/warehouse/grn/${record.id}`);
  };

  const handleSubmitForQI = async (id) => {
    try {
      await api.put(`/warehouse/grn/${id}/submit-qi`);
      message.success('GRN submitted for Quality Inspection');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleComplete = async (id) => {
    try {
      await api.put(`/warehouse/grn/${id}/complete`);
      message.success('GRN completed');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/warehouse/grn/${id}`);
      message.success('GRN deleted');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const columns = [
    {
      title: 'GRN Number',
      dataIndex: 'grn_number',
      key: 'grn_number',
      width: 150,
      sorter: true,
      fixed: 'left',
      render: (text, record) => (
        <a onClick={() => handleView(record)}>{text}</a>
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
      title: 'PO Reference',
      dataIndex: 'po_number',
      key: 'po_number',
      width: 140,
      render: (v) => v || '-',
    },
    {
      title: 'Inward Reference',
      dataIndex: 'inward_number',
      key: 'inward_number',
      width: 140,
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
      title: 'GRN Date',
      dataIndex: 'grn_date',
      key: 'grn_date',
      width: 150,
      sorter: true,
      render: (v) => v ? formatDate(v) : '-',
    },
    {
      title: 'Supplier Invoice',
      dataIndex: 'supplier_invoice',
      key: 'supplier_invoice',
      width: 140,
      render: (v) => v || '-',
    },
    {
      title: 'Receipt Type',
      dataIndex: 'receipt_type',
      key: 'receipt_type',
      width: 110,
      render: (v) => {
        const typeMap = { inward_based: 'Inward Based', po_based: 'PO Based', direct: 'Direct', return: 'Return', transfer: 'Transfer' };
        return <Tag>{typeMap[v] || v || '-'}</Tag>;
      },
    },
    {
      title: 'Total Qty',
      dataIndex: 'total_qty',
      key: 'total_qty',
      width: 90,
      align: 'right',
      render: (v) => formatNumber(v),
    },
    {
      title: 'Accepted',
      dataIndex: 'accepted_qty',
      key: 'accepted_qty',
      width: 90,
      align: 'right',
      render: (v) => <Text style={{ color: '#52c41a' }}>{formatNumber(v)}</Text>,
    },
    {
      title: 'Rejected',
      dataIndex: 'rejected_qty',
      key: 'rejected_qty',
      width: 90,
      align: 'right',
      render: (v) => <Text style={{ color: v > 0 ? '#f5222d' : undefined }}>{formatNumber(v)}</Text>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 130,
      render: (s) => <StatusTag status={s} />,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 200,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="View Detail">
            <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleView(record)} />
          </Tooltip>
          {record.status === 'draft' && (
            <>
              <Tooltip title="Edit">
                <Button type="link" size="small" icon={<EditOutlined />} onClick={() => navigate(`/warehouse/grn/${record.id}?edit=true`)} />
              </Tooltip>
              <Tooltip title="Submit for QI">
                <Popconfirm title="Submit this GRN for Quality Inspection?" onConfirm={() => handleSubmitForQI(record.id)}>
                  <Button type="link" size="small" icon={<ExperimentOutlined />} style={{ color: '#722ed1' }} />
                </Popconfirm>
              </Tooltip>
              <Popconfirm title="Delete this GRN?" onConfirm={() => handleDelete(record.id)} okButtonProps={{ danger: true }}>
                <Button type="link" size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            </>
          )}
          {(record.status === 'pending_qi' || record.status === 'qi_in_progress') && (
            <Tooltip title="Complete GRN">
              <Popconfirm title="Mark this GRN as completed?" onConfirm={() => handleComplete(record.id)}>
                <Button type="link" size="small" icon={<CheckOutlined />} style={{ color: '#52c41a' }} />
              </Popconfirm>
            </Tooltip>
          )}
        </Space>
      ),
    },
  ];

  const toolbar = (
    <Space style={{ marginLeft: 12 }} wrap>
      <Select
        placeholder="Status"
        allowClear
        style={{ width: 150 }}
        value={filterStatus}
        onChange={(v) => { setFilterStatus(v); setRefreshKey((k) => k + 1); }}
        options={GRN_STATUSES}
      />
      <Select
        placeholder="Vendor"
        allowClear
        showSearch
        filterOption={(input, option) => (option?.label ?? '').toLowerCase().includes(input.toLowerCase())}
        style={{ width: 180 }}
        value={filterVendor}
        onChange={(v) => { setFilterVendor(v); setRefreshKey((k) => k + 1); }}
        options={vendors}
      />
      <Select
        placeholder="Warehouse"
        allowClear
        showSearch
        filterOption={(input, option) => (option?.label ?? '').toLowerCase().includes(input.toLowerCase())}
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
      <PageHeader title="Goods Receipt Note" subtitle="Track and manage received goods">
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            Create GRN
          </Button>
        </Space>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchGRNs}
        rowKey="id"
        searchPlaceholder="Search by GRN number or vendor..."
        exportFileName="grns"
        toolbar={toolbar}
        scroll={{ x: 1500 }}
      />
    </div>
  );
};

export default GRN;
