// @ts-nocheck
import React, { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button, Select, Space, DatePicker, Popconfirm, message, Tooltip, Tag
} from 'antd';
import {
  PlusOutlined, EyeOutlined, CheckOutlined, CloseCircleOutlined
} from '@ant-design/icons';
import PageHeader from '../components/PageHeader';
import DataTable from '../components/DataTable';
import StatusTag from '../components/StatusTag';
import api from '../config/api';
import useAuthStore from '../store/authStore';
import {
  formatDate, getErrorMessage, formatDateForAPI
} from '../utils/helpers';
import { DATE_FORMAT } from '../utils/constants';

const QI_STATUSES = [
  { label: 'Draft', value: 'draft' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'Completed', value: 'completed' },
  { label: 'Cancelled', value: 'cancelled' },
];

const RESULT_FILTER_OPTIONS = [
  { label: 'Pass', value: 'pass' },
  { label: 'Fail', value: 'fail' },
  { label: 'Partial', value: 'partial' },
];

const resultColors = {
  accepted: '#52c41a',
  pass: '#52c41a',
  rejected: '#f5222d',
  fail: '#f5222d',
  hold: '#fa8c16',
  partial: '#fa8c16',
};

const QualityInspection = () => {
  const hasKey = useAuthStore((s) => s.hasKey);
  const canRunQI = hasKey('warehouse-quality-inspection');
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);

  // Filters
  const [filterResult, setFilterResult] = useState(undefined);
  const [filterStatus, setFilterStatus] = useState(undefined);
  const [filterDateRange, setFilterDateRange] = useState(null);

  // --- Fetch QIs ---
  const fetchQIs = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterResult) qp.overall_result = filterResult;
      if (filterStatus) qp.status = filterStatus;
      if (filterDateRange && filterDateRange[0]) {
        qp.date_from = formatDateForAPI(filterDateRange[0]);
        qp.date_to = formatDateForAPI(filterDateRange[1]);
      }
      return await api.get('/warehouse/quality-inspections', { params: qp });
    },
    [filterResult, filterStatus, filterDateRange]
  );

  // --- Actions ---
  const handleCompleteQI = async (id) => {
    try {
      await api.put(`/warehouse/quality-inspections/${id}/complete`);
      message.success('Quality Inspection completed. Redirecting to Putaway...', 2);
      setRefreshKey((k) => k + 1);
      setTimeout(() => navigate('/warehouse/putaway'), 1200);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleCancelQI = async (id) => {
    try {
      await api.put(`/warehouse/quality-inspections/${id}/cancel`);
      message.success('Quality Inspection cancelled');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // --- Main Table Columns ---
  const columns = [
    {
      title: 'QI Number',
      dataIndex: 'qi_number',
      key: 'qi_number',
      width: 150,
      sorter: true,
      fixed: 'left',
      render: (text, record) => <a onClick={() => navigate(`/warehouse/quality-inspection/${record.id}`)}>{text}</a>,
    },
    {
      title: 'GRN Reference',
      dataIndex: 'grn_number',
      key: 'grn_number',
      width: 150,
      render: (v) => v || '-',
    },
    {
      title: 'Inspection Date',
      dataIndex: 'inspection_date',
      key: 'inspection_date',
      width: 120,
      sorter: true,
      render: (v) => formatDate(v),
    },
    {
      title: 'Inspection Type',
      dataIndex: 'inspection_type',
      key: 'inspection_type',
      width: 140,
      render: (v) => {
        const typeMap = { full: 'Full', sample: 'Sample', visual: 'Visual', measurement: 'Measurement' };
        return <Tag>{typeMap[v] || v || '-'}</Tag>;
      },
    },
    {
      title: 'Overall Result',
      dataIndex: 'overall_result',
      key: 'overall_result',
      width: 120,
      render: (v) => {
        if (!v) return <Tag color="default">Pending</Tag>;
        const color = resultColors[v] || '#8c8c8c';
        const label = v === 'pass' ? 'Pass' : v === 'fail' ? 'Fail' : 'Partial';
        return <Tag style={{ color: '#fff', backgroundColor: color, borderColor: color }}>{label}</Tag>;
      },
    },
    {
      title: 'Inspected By',
      dataIndex: 'inspected_by_name',
      key: 'inspected_by',
      width: 140,
      render: (v, r) => v || r.inspected_by || '-',
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (s) => <StatusTag status={s} />,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 160,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="View Detail">
            <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => navigate(`/warehouse/quality-inspection/${record.id}`)} />
          </Tooltip>
          {canRunQI && (record.status === 'draft' || record.status === 'in_progress') && (
            <Tooltip title="Complete Inspection">
              <Popconfirm
                title="Complete this Quality Inspection? This will trigger putaway generation for accepted items."
                onConfirm={() => handleCompleteQI(record.id)}
              >
                <Button type="link" size="small" icon={<CheckOutlined />} style={{ color: '#52c41a' }} />
              </Popconfirm>
            </Tooltip>
          )}
          {canRunQI && record.status === 'draft' && (
            <Tooltip title="Cancel">
              <Popconfirm title="Cancel this Quality Inspection?" onConfirm={() => handleCancelQI(record.id)} okButtonProps={{ danger: true }}>
                <Button type="link" size="small" danger icon={<CloseCircleOutlined />} />
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
        placeholder="Result"
        allowClear
        style={{ width: 120 }}
        value={filterResult}
        onChange={(v) => { setFilterResult(v); setRefreshKey((k) => k + 1); }}
        options={RESULT_FILTER_OPTIONS}
      />
      <Select
        placeholder="Status"
        allowClear
        style={{ width: 140 }}
        value={filterStatus}
        onChange={(v) => { setFilterStatus(v); setRefreshKey((k) => k + 1); }}
        options={QI_STATUSES}
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
      <PageHeader title="Quality Inspection" subtitle="Manage inbound quality inspections">
        <Space>
          {canRunQI && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/warehouse/quality-inspection/new')}>
              Create QI
            </Button>
          )}
        </Space>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchQIs}
        rowKey="id"
        searchPlaceholder="Search by QI number, GRN number..."
        exportFileName="quality_inspections"
        toolbar={toolbar}
        scroll={{ x: 1200 }}
      />
    </div>
  );
};

export default QualityInspection;


