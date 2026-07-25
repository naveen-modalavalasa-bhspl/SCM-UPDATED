// @ts-nocheck
import React, { useState, useCallback, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  Button, Select, Space, Popconfirm, message, Input, Tooltip
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined,
  SendOutlined
} from '@ant-design/icons';
import PageHeader from '../components/PageHeader';
import DataTable from '../components/DataTable';
import StatusTag from '../components/StatusTag';
import api from '../config/api';
import {
  formatDate, getErrorMessage, downloadExcel
} from '../utils/helpers';

const MI_STATUSES = [
  { label: 'Draft', value: 'draft' },
  { label: 'Issued', value: 'issued' },
  { label: 'Dispatched', value: 'dispatched' },
  { label: 'Acknowledged', value: 'acknowledged' },
  { label: 'Completed', value: 'completed' },
  { label: 'Cancelled', value: 'cancelled' },
];

const MaterialIssues = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);

  // Filters
  const [filterStatus, setFilterStatus] = useState(undefined);
  const [filterWarehouse, setFilterWarehouse] = useState(undefined);
  const [filterDepartment, setFilterDepartment] = useState(undefined);

  const [warehouses, setWarehouses] = useState([]);

  // --- Lookups ---
  const loadLookups = useCallback(async () => {
    try {
      const whRes = await api.get('/masters/warehouses', { params: { page_size: 200, exclude_virtual: true } });
      const w = whRes.data;
      setWarehouses(
        (w.items || w.data || w || []).map((i) => ({
          label: i.name || i.warehouse_name,
          value: i.id,
        }))
      );
    } catch (err) {
      console.error('Error loading lookups:', err);
    }
  }, []);

  // Handle redirect if deep-linked from Indents page with indent_id
  useEffect(() => {
    const indentId = searchParams.get('indent_id');
    if (indentId) {
      navigate(`/warehouse/material-issues/new?indent_id=${indentId}`, { replace: true });
    }
  }, [searchParams, navigate]);

  useEffect(() => {
    loadLookups();
  }, [loadLookups]);

  // --- Fetch ---
  const fetchRecords = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterStatus) qp.status = filterStatus;
      if (filterWarehouse) qp.warehouse_id = filterWarehouse;
      if (filterDepartment) qp.department = filterDepartment;
      return await api.get('/warehouse/material-issues', { params: qp });
    },
    [filterStatus, filterWarehouse, filterDepartment]
  );

  // --- Actions ---
  const handleIssue = async (id) => {
    try {
      await api.post(`/warehouse/material-issues/${id}/issue`);
      message.success('Material issued successfully, stock reserved');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/warehouse/material-issues/${id}`);
      message.success('Material Issue deleted');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // --- Main Table Columns ---
  const columns = [
    {
      title: 'Issue Number',
      dataIndex: 'issue_number',
      key: 'issue_number',
      width: 160,
      sorter: true,
      fixed: 'left',
      render: (text, record) => (
        <a onClick={() => navigate(`/warehouse/material-issues/${record.id}`)}>{text}</a>
      ),
    },
    {
      title: 'Source Warehouse',
      dataIndex: 'warehouse_name',
      key: 'warehouse',
      width: 150,
      ellipsis: true,
      render: (v) => v || '-',
    },
    {
      title: 'Destination Warehouse',
      dataIndex: 'destination_warehouse_name',
      key: 'destination_warehouse',
      width: 160,
      ellipsis: true,
      render: (v) => v || '-',
    },
    {
      title: 'Department',
      dataIndex: 'department',
      key: 'department',
      width: 140,
      render: (v) => v || '-',
    },
    {
      title: 'Issue Date',
      dataIndex: 'issue_date',
      key: 'issue_date',
      width: 120,
      sorter: true,
      render: (v) => formatDate(v),
    },
    {
      title: 'Issued To',
      dataIndex: 'issued_to_name',
      key: 'issued_to',
      width: 150,
      ellipsis: true,
      render: (v, r) => v || r.issued_to || '-',
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
      width: 180,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="View Detail">
            <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => navigate(`/warehouse/material-issues/${record.id}`)} />
          </Tooltip>
          {record.status === 'draft' && (
            <>
              <Tooltip title="Edit">
                <Button type="link" size="small" icon={<EditOutlined />} onClick={() => navigate(`/warehouse/material-issues/${record.id}?edit=true`)} />
              </Tooltip>
              <Tooltip title="Issue Material (Reserve)">
                <Popconfirm
                  title="Issue this material? Stock will be reserved."
                  onConfirm={() => handleIssue(record.id)}
                >
                  <Button type="link" size="small" icon={<SendOutlined />} style={{ color: '#eb2f96' }} />
                </Popconfirm>
              </Tooltip>
              <Popconfirm title="Delete this Material Issue?" onConfirm={() => handleDelete(record.id)} okButtonProps={{ danger: true }}>
                <Button type="link" size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            </>
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
        style={{ width: 150 }}
        value={filterStatus}
        onChange={(v) => { setFilterStatus(v); setRefreshKey((k) => k + 1); }}
        options={MI_STATUSES}
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
        onOpenChange={(open) => { if (open && warehouses.length === 0) loadLookups(); }}
      />
      <Input
        placeholder="Department"
        allowClear
        style={{ width: 150 }}
        value={filterDepartment}
        onChange={(e) => { setFilterDepartment(e.target.value || undefined); }}
        onPressEnter={() => setRefreshKey((k) => k + 1)}
      />
    </Space>
  );

  const handleCustomExport = (data) => {
    const exportRows = [];
    data.forEach(row => {
      const items = row.items || [];
      if (items.length === 0) {
        exportRows.push({
          'Issue Number': row.issue_number || '-',
          'Issue Date': row.issue_date ? new Date(row.issue_date).toLocaleDateString() : '-',
          'Source Warehouse': row.warehouse_name || '-',
          'Destination Warehouse': row.destination_warehouse_name || '-',
          'Vehicle Code': row.vehicle_code || '-',
          'Vehicle Number': row.vehicle_number || '-',
          'Item Name': '-',
          'Item Code': '-',
          'Item Type': '-',
          'Qty Issued': '-',
          'Serial / Asset No': '-',
          'Department': row.department || '-',
          'Issued To': row.issued_to_name || row.issued_to || '-',
          'Status': row.status || '-',
        });
      } else {
        items.forEach(item => {
          const serials = item.serial_numbers || [];
          if (serials.length === 0) {
            exportRows.push({
              'Issue Number': row.issue_number || '-',
              'Issue Date': row.issue_date ? new Date(row.issue_date).toLocaleDateString() : '-',
              'Source Warehouse': row.warehouse_name || '-',
              'Destination Warehouse': row.destination_warehouse_name || '-',
              'Vehicle Code': row.vehicle_code || '-',
              'Vehicle Number': row.vehicle_number || '-',
              'Item Name': item.item_name || '-',
              'Item Code': item.item_code || '-',
              'Item Type': item.item_type || '-',
              'Qty Issued': item.qty ?? '-',
              'Serial / Asset No': '-',
              'Department': row.department || '-',
              'Issued To': row.issued_to_name || row.issued_to || '-',
              'Status': row.status || '-',
            });
          } else {
            serials.forEach((serial, idx) => {
              exportRows.push({
                'Issue Number': row.issue_number || '-',
                'Issue Date': row.issue_date ? new Date(row.issue_date).toLocaleDateString() : '-',
                'Source Warehouse': row.warehouse_name || '-',
                'Destination Warehouse': row.destination_warehouse_name || '-',
                'Vehicle Code': row.vehicle_code || '-',
                'Vehicle Number': row.vehicle_number || '-',
                'Item Name': item.item_name || '-',
                'Item Code': item.item_code || '-',
                'Item Type': item.item_type || '-',
                'Qty Issued': idx === 0 ? (item.qty ?? '-') : '',
                'Serial / Asset No': serial || '-',
                'Department': row.department || '-',
                'Issued To': row.issued_to_name || row.issued_to || '-',
                'Status': row.status || '-',
              });
            });
          }
        });
      }
    });
    downloadExcel(exportRows, 'material_issues_list', 'Material Issues Log');
  };

  return (
    <div>
      <PageHeader title="Material Issues" subtitle="Manage material issues from warehouse">
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/warehouse/material-issues/new')}>
            Create Issue
          </Button>
        </Space>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchRecords}
        rowKey="id"
        searchPlaceholder="Search by issue number, department..."
        exportFileName="material_issues_list"
        toolbar={toolbar}
        scroll={{ x: 1200 }}
        customExport={handleCustomExport}
      />
    </div>
  );
};

export default MaterialIssues;
