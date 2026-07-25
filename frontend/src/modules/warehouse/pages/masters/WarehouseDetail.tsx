// @ts-nocheck
import React, { useState, useEffect } from 'react';
import {
  Card, Descriptions, Spin, Space, Button, message, Empty,
} from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { useParams, useNavigate } from 'react-router-dom';
import PageHeader from '../../components/PageHeader';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import { getErrorMessage } from '../../utils/helpers';

const WarehouseDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [warehouse, setWarehouse] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (id) fetchWarehouse();
  }, [id]);

  const fetchWarehouse = async () => {
    setLoading(true);
    try {
      const res = await api.get(`/masters/warehouses/${id}`);
      setWarehouse(res.data);
    } catch (err) {
      message.error(getErrorMessage(err));
      navigate('/masters/warehouses');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return <div style={{ display: 'flex', justifyContent: 'center', padding: 100 }}><Spin size="large" /></div>;
  }

  if (!warehouse) {
    return <div><PageHeader title="Warehouse Not Found" /><Empty /></div>;
  }

  return (
    <div>
      <PageHeader title={warehouse.name || warehouse.warehouse_name} subtitle="Warehouse Detail">
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/masters/warehouses')}>Back to Warehouses</Button>
      </PageHeader>
      <Card>
        <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
          <Descriptions.Item label="Name">{warehouse.name || warehouse.warehouse_name}</Descriptions.Item>
          <Descriptions.Item label="Code">{warehouse.code || '-'}</Descriptions.Item>
          <Descriptions.Item label="Type">{warehouse.warehouse_type || '-'}</Descriptions.Item>
          <Descriptions.Item label="Parent Warehouse">{warehouse.parent_name || 'None (Top Level)'}</Descriptions.Item>
          <Descriptions.Item label="Address" span={2}>{warehouse.address || '-'}</Descriptions.Item>
          <Descriptions.Item label="City">{warehouse.city || '-'}</Descriptions.Item>
          <Descriptions.Item label="State">{warehouse.state || '-'}</Descriptions.Item>
          <Descriptions.Item label="Pincode">{warehouse.pincode || '-'}</Descriptions.Item>
          <Descriptions.Item label="Contact">{warehouse.contact_person || '-'}</Descriptions.Item>
          <Descriptions.Item label="Phone">{warehouse.contact_phone || '-'}</Descriptions.Item>
          <Descriptions.Item label="Status"><StatusTag status={warehouse.status} /></Descriptions.Item>
          {warehouse.description && <Descriptions.Item label="Description" span={3}>{warehouse.description}</Descriptions.Item>}
        </Descriptions>
      </Card>
    </div>
  );
};

export default WarehouseDetail;
