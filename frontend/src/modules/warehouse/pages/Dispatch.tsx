// @ts-nocheck
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Tag, Space, Popconfirm, message } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined } from '@ant-design/icons';
import PageHeader from '../components/PageHeader';
import DataTable from '../components/DataTable';
import StatusTag from '../components/StatusTag';
import api from '../config/api';
import { formatDate, getErrorMessage } from '../utils/helpers';

const Dispatch = () => {
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);

  const handleDelete = async (id) => {
    try {
      await api.delete(`/warehouse/dispatch/${id}`);
      message.success('Dispatch deleted successfully');
      setRefreshKey(k => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const columns = [
    {
      title: 'Dispatch No.',
      dataIndex: 'dispatch_id',
      key: 'dispatch_id',
      width: 150,
      render: (text) => <span style={{ fontWeight: 500, color: '#481890' }}>{text}</span>,
    },
    {
      title: 'Date',
      dataIndex: 'dispatch_date',
      key: 'dispatch_date',
      width: 120,
      render: (val) => formatDate(val),
    },
    {
      title: 'Remarks',
      dataIndex: 'remarks',
      key: 'remarks',
      ellipsis: true,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (status) => <StatusTag status={status} />,
    },
    {
      title: 'Action',
      key: 'action',
      width: 200,
      align: 'right',
      render: (_, record) => (
        <Space size="small">
          <Button
            type="text"
            icon={record.status === 'Draft' ? <EditOutlined /> : <EyeOutlined />}
            onClick={() => navigate(`/logistics/dispatch-orders/${record.dispatch_id}`)}
          />
          {(record.status === 'Dispatched' || record.status === 'Delivered') && (
            <Button
              type="link"
              size="small"
              onClick={() => navigate(`/logistics/dispatch-orders/${record.dispatch_id}/acknowledge`)}
              style={{ padding: 0 }}
            >
              Acknowledge
            </Button>
          )}
          {record.status === 'Draft' && (
            <Popconfirm
              title="Delete this dispatch?"
              onConfirm={() => handleDelete(record.dispatch_id)}
              okText="Yes"
              cancelText="No"
              placement="left"
            >
              <Button type="text" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Dispatch Management"
        subtitle="Manage warehouse outward dispatches"
      >
        <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/logistics/dispatch-orders/new')}>
          New Dispatch
        </Button>
      </PageHeader>
      <DataTable
        url="/warehouse/dispatch"
        columns={columns}
        rowKey="dispatch_id"
        refreshKey={refreshKey}
      />
    </div>
  );
};

export default Dispatch;
