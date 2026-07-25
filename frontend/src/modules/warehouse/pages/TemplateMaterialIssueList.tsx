// @ts-nocheck
import React, { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Select, Space, Popconfirm, message } from 'antd';
import { PlusOutlined, EyeOutlined, StopOutlined } from '@ant-design/icons';
import PageHeader from '../components/PageHeader';
import DataTable from '../components/DataTable';
import StatusTag from '../components/StatusTag';
import api from '../config/api';
import { formatDate, getErrorMessage } from '../utils/helpers';
import useAuthStore from '../store/authStore';

const TemplateMaterialIssueList = ({ templateType, title }) => {
  const { user: currentUser } = useAuthStore();
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);
  const [filterStatus, setFilterStatus] = useState(undefined);
  const [filterProject, setFilterProject] = useState(undefined);
  const [projects, setProjects] = useState([]);

  const isRaiser = (record) => record?.issued_by === currentUser?.id;

  const loadProjects = useCallback(async () => {
    try {
      const projRes = await api.get('/masters/projects', { params: { page_size: 200 } });
      const data = projRes.data?.items || projRes.data?.data || projRes.data || [];
      setProjects(data.map((p) => ({ label: p.name || p.project_name, value: p.id })));
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  const fetchData = useCallback(
    async (params) => {
      const qp = { ...params, template_type: templateType };
      if (filterStatus) qp.status = filterStatus;
      if (filterProject) qp.project_id = filterProject;
      return await api.get('/warehouse/material-issues', { params: qp });
    },
    [filterStatus, filterProject, templateType]
  );

  const handleAction = async (id, action) => {
    try {
      await api.post(`/warehouse/material-issues/${id}/${action}`);
      const labels = { submit: 'submitted', reject: 'rejected', cancel: 'cancelled' };
      message.success(`Material issue ${labels[action] || action}`);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const columns = [
    {
      title: 'Issue #',
      dataIndex: 'issue_number',
      key: 'issue_number',
      width: 150,
      sorter: true,
      fixed: 'left',
      render: (text, record) => (
        <a onClick={() => navigate(`/warehouse/material-issues/ap104-${templateType}/${record.id}`)}>
          {text}
        </a>
      ),
    },
    { title: 'Project', dataIndex: 'project_name', key: 'project', width: 200, render: (v) => v || '-' },
    { title: 'Source WH', dataIndex: 'warehouse_name', key: 'warehouse', width: 180, render: (v) => v || '-' },
    { title: 'Destination WH', dataIndex: 'destination_warehouse_name', key: 'dest_warehouse', width: 180, render: (v) => v || '-' },
    { title: 'Department', dataIndex: 'department', key: 'department', width: 120, render: (v) => v || '-' },
    { title: 'Vehicle Number', dataIndex: 'vehicle_number', key: 'vehicle_number', width: 150, render: (v) => v || '-' },
    { title: 'Issue Date', dataIndex: 'issue_date', key: 'issue_date', width: 120, sorter: true, render: (v) => formatDate(v) },
    { title: 'Issued To', dataIndex: 'issued_to_name', key: 'issued_to', width: 140, render: (v) => v || '-' },
    { title: 'Status', dataIndex: 'status', key: 'status', width: 150, render: (s) => <StatusTag status={s} /> },
    {
      title: 'Actions',
      key: 'actions',
      width: 120,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Button
            type="link"
            size="small"
            icon={<EyeOutlined />}
            onClick={() => navigate(`/warehouse/material-issues/ap104-${templateType}/${record.id}`)}
          />
          {record.status === 'draft' && isRaiser(record) && (
            <Popconfirm
              title="Cancel this draft?"
              onConfirm={() => handleAction(record.id, 'cancel')}
              okButtonProps={{ danger: true }}
            >
              <Button type="link" size="small" danger icon={<StopOutlined />} />
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
        style={{ width: 160 }}
        value={filterStatus}
        onChange={(v) => { setFilterStatus(v); setRefreshKey((k) => k + 1); }}
        options={[
          { label: 'Draft', value: 'draft' },
          { label: 'Issued', value: 'issued' },
          { label: 'Dispatched', value: 'dispatched' },
          { label: 'Acknowledged', value: 'acknowledged' },
          { label: 'Completed', value: 'completed' },
          { label: 'Cancelled', value: 'cancelled' },
        ]}
      />
      {projects.length > 1 && (
        <Select
          placeholder="Project"
          allowClear
          style={{ width: 200 }}
          value={filterProject}
          onChange={(v) => { setFilterProject(v); setRefreshKey((k) => k + 1); }}
          options={projects}
          showSearch
          filterOption={(input, option) => (option?.label ?? '').toLowerCase().includes(input.toLowerCase())}
        />
      )}
    </Space>
  );

  return (
    <div>
      <PageHeader title={title} subtitle={`Template-based material issues for ${templateType}`}>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => navigate(`/warehouse/material-issues/ap104-${templateType}/new`)}
        >
          Create Template Issue
        </Button>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchData}
        rowKey="id"
        searchPlaceholder="Search by issue number..."
        exportFileName={`template_material_issues_${templateType}`}
        toolbar={toolbar}
        scroll={{ x: 1400 }}
      />
    </div>
  );
};

export default TemplateMaterialIssueList;
